import { Signal } from './base/Signal';
import { parseUri } from './base/parseUri';
import type { IResourceMetadata } from './LoaderResource';
import { LoaderResource } from './LoaderResource';
import { AsyncQueue } from './base/AsyncQueue';
import type { Dict } from '@pixi/utils';
import { deprecation } from '@pixi/utils';
import { extensions, ExtensionType } from '@pixi/core';

// some constants
const MAX_PROGRESS = 100;
const rgxExtractUrlHash = /(#[\w-]+)?$/;

export type ILoaderMiddleware = (resource: LoaderResource, next: (...args: any[]) => void) => void;

export interface ILoaderAdd
{
    (this: Loader, name: string, url: string, callback?: LoaderResource.OnCompleteSignal): Loader;
    (this: Loader, name: string, url: string, options?: IAddOptions, callback?: LoaderResource.OnCompleteSignal): Loader;
    (this: Loader, url: string, callback?: LoaderResource.OnCompleteSignal): Loader;
    (this: Loader, url: string, options?: IAddOptions, callback?: LoaderResource.OnCompleteSignal): Loader;
    (this: Loader, options: IAddOptions, callback?: LoaderResource.OnCompleteSignal): Loader;
    (this: Loader, resources: (IAddOptions | string)[], callback?: LoaderResource.OnCompleteSignal): Loader;
}

/**
 * Options for a call to `.add()`.
 * @see Loader#add
 * @property {string} name - The name of the resource to load, if not passed the url is used.
 * @property {string} key - Alias for `name`.
 * @property {string} url - The url for this resource, relative to the baseUrl of this loader.
 * @property {string|boolean} crossOrigin - Is this request cross-origin? Default is to determine automatically.
 * @property {number} [timeout=0] - A timeout in milliseconds for the load. If the load takes longer
 *      than this time it is cancelled and the load is considered a failure. If this value is
 *      set to `0` then there is no explicit timeout.
 * @property {LoaderResource.LOAD_TYPE} [loadType=LoaderResource.LOAD_TYPE.XHR] - How should this resource be loaded?
 * @property {LoaderResource.XHR_RESPONSE_TYPE} [xhrType=LoaderResource.XHR_RESPONSE_TYPE.DEFAULT] - How should the data
 *      being loaded be interpreted when using XHR?
 * @property {LoaderResource.OnCompleteSignal} onComplete - Callback to add an an onComplete signal istener.
 * @property {LoaderResource.OnCompleteSignal} callback - Alias for `onComplete`.
 * @property {IResourceMetadata} metadata - Extra configuration for middleware and the Resource object.
 */
export interface IAddOptions
{
    name?: string;
    key?: string;
    url?: string;
    crossOrigin?: string | boolean;
    timeout?: number;
    parentResource?: LoaderResource;
    loadType?: LoaderResource.LOAD_TYPE;
    xhrType?: LoaderResource.XHR_RESPONSE_TYPE;
    onComplete?: LoaderResource.OnCompleteSignal;
    callback?: LoaderResource.OnCompleteSignal;
    metadata?: IResourceMetadata;
}

/**
 * The new loader, forked from Resource Loader by Chad Engler: https://github.com/englercj/resource-loader
 *
 * ```js
 * const loader = PIXI.Loader.shared; // PixiJS exposes a premade instance for you to use.
 * // or
 * const loader = new PIXI.Loader(); // You can also create your own if you want
 *
 * const sprites = {};
 *
 * // Chainable `add` to enqueue a resource
 * loader.add('bunny', 'data/bunny.png')
 *       .add('spaceship', 'assets/spritesheet.json');
 * loader.add('scoreFont', 'assets/score.fnt');
 *
 * // Chainable `pre` to add a middleware that runs for each resource, *before* loading that resource.
 * // This is useful to implement custom caching modules (using filesystem, indexeddb, memory, etc).
 * loader.pre(cachingMiddleware);
 *
 * // Chainable `use` to add a middleware that runs for each resource, *after* loading that resource.
 * // This is useful to implement custom parsing modules (like spritesheet parsers, spine parser, etc).
 * loader.use(parsingMiddleware);
 *
 * // The `load` method loads the queue of resources, and calls the passed in callback called once all
 * // resources have loaded.
 * loader.load((loader, resources) => {
 *     // resources is an object where the key is the name of the resource loaded and the value is the resource object.
 *     // They have a couple default properties:
 *     // - `url`: The URL that the resource was loaded from
 *     // - `error`: The error that happened when trying to load (if any)
 *     // - `data`: The raw data that was loaded
 *     // also may contain other properties based on the middleware that runs.
 *     sprites.bunny = new PIXI.TilingSprite(resources.bunny.texture);
 *     sprites.spaceship = new PIXI.TilingSprite(resources.spaceship.texture);
 *     sprites.scoreFont = new PIXI.TilingSprite(resources.scoreFont.texture);
 * });
 *
 * // throughout the process multiple signals can be dispatched.
 * loader.onProgress.add(() => {}); // called once per loaded/errored file
 * loader.onError.add(() => {}); // called once per errored file
 * loader.onLoad.add(() => {}); // called once per loaded file
 * loader.onComplete.add(() => {}); // called once when the queued resources all load.
 * ```
 * @memberof PIXI
 */
class Loader
{
    /** The base url for all resources loaded by this loader. */
    baseUrl: string;

    /** The progress percent of the loader going through the queue. */
    progress = 0;

    /** Loading state of the loader, true if it is currently loading resources. */
    loading = false;

    /**
     * A querystring to append to every URL added to the loader.
     *
     * This should be a valid query string *without* the question-mark (`?`). The loader will
     * also *not* escape values for you. Make sure to escape your parameters with
     * [`encodeURIComponent`](https://mdn.io/encodeURIComponent) before assigning this property.
     * @example
     * const loader = new Loader();
     *
     * loader.defaultQueryString = 'user=me&password=secret';
     *
     * // This will request 'image.png?user=me&password=secret'
     * loader.add('image.png').load();
     *
     * loader.reset();
     *
     * // This will request 'image.png?v=1&user=me&password=secret'
     * loader.add('iamge.png?v=1').load();
     */
    defaultQueryString = '';

    /** The middleware to run before loading each resource. */
    private _beforeMiddleware: Array<ILoaderMiddleware> = [];

    /** The middleware to run after loading each resource. */
    private _afterMiddleware: Array<ILoaderMiddleware> = [];

    /** The tracks the resources we are currently completing parsing for. */
    private _resourcesParsing: Array<LoaderResource> = [];

    /**
     * The `_loadResource` function bound with this object context.
     * @param r - The resource to load
     * @param d - The dequeue function
     */
    private _boundLoadResource = (r: LoaderResource, d: () => void): void => this._loadResource(r, d);

    /** The resources waiting to be loaded. */
    private _queue: AsyncQueue<any>;

    /** All the resources for this loader keyed by name. */
    resources: Dict<LoaderResource> = {};

    /** Dispatched once per loaded or errored resource. */
    onProgress: Signal<Loader.OnProgressSignal>;

    /** Dispatched once per errored resource. */
    onError: Signal<Loader.OnErrorSignal>;

    /** Dispatched once per loaded resource. */
    onLoad: Signal<Loader.OnLoadSignal>;

    /** Dispatched when the loader begins to process the queue. */
    onStart: Signal<Loader.OnStartSignal>;

    /** Dispatched when the queued resources all load. */
    onComplete: Signal<Loader.OnCompleteSignal>;

    /**
     * @param baseUrl - The base url for all resources loaded by this loader.
     * @param concurrency - The number of resources to load concurrently.
     */
    constructor(baseUrl = '', concurrency = 10)
    {
        this.baseUrl = baseUrl;
        this._beforeMiddleware = [];
        this._afterMiddleware = [];
        this._resourcesParsing = [];
        this._boundLoadResource = (r, d) => this._loadResource(r, d);
        this._queue = AsyncQueue.queue(this._boundLoadResource, concurrency);
        this._queue.pause();
        this.resources = {};
        this.onProgress = new Signal();
        this.onError = new Signal();
        this.onLoad = new Signal();
        this.onStart = new Signal();
        this.onComplete = new Signal();

        for (let i = 0; i < Loader._plugins.length; ++i)
        {
            const plugin = Loader._plugins[i];
            const { pre, use } = plugin;

            if (pre)
            {
                this.pre(pre);
            }

            if (use)
            {
                this.use(use);
            }
        }

        this._protected = false;
    }

    /**
     * Adds a resource (or multiple resources) to the loader queue.
     *
     * This function can take a wide variety of different parameters. The only thing that is always
     * required the url to load. All the following will work:
     *
     * ```js
     * loader
     *     // normal param syntax
     *     .add('key', 'http://...', function () {})
     *     .add('http://...', function () {})
     *     .add('http://...')
     *
     *     // object syntax
     *     .add({
     *         name: 'key2',
     *         url: 'http://...'
     *     }, function () {})
     *     .add({
     *         url: 'http://...'
     *     }, function () {})
     *     .add({
     *         name: 'key3',
     *         url: 'http://...'
     *         onComplete: function () {}
     *     })
     *     .add({
     *         url: 'https://...',
     *         onComplete: function () {},
     *         crossOrigin: true
     *     })
     *
     *     // you can also pass an array of objects or urls or both
     *     .add([
     *         { name: 'key4', url: 'http://...', onComplete: function () {} },
     *         { url: 'http://...', onComplete: function () {} },
     *         'http://...'
     *     ])
     *
     *     // and you can use both params and options
     *     .add('key', 'http://...', { crossOrigin: true }, function () {})
     *     .add('http://...', { crossOrigin: true }, function () {});
     * ```
     */
    add: ILoaderAdd;

    /**
     * Same as add, params have strict order
     * @private
     * @param name - The name of the resource to load.
     * @param url - The url for this resource, relative to the baseUrl of this loader.
     * @param options - The options for the load.
     * @param callback - Function to call when this specific resource completes loading.
     * @returns The loader itself.
     */
    protected _add(name: string, url: string, options: IAddOptions, callback?: LoaderResource.OnCompleteSignal): this
    {
        // if loading already you can only add resources that have a parent.
        if (this.loading && (!options || !options.parentResource))
        {
            throw new Error('Cannot add resources while the loader is running.');
        }

        // check if resource already exists.
        if (this.resources[name])
        {
            throw new Error(`Resource named "${name}" already exists.`);
        }

        // add base url if this isn't an absolute url
        url = this._prepareUrl(url);

        // create the store the resource
        this.resources[name] = new LoaderResource(name, url, options);

        if (typeof callback === 'function')
        {
            this.resources[name].onAfterMiddleware.once(callback);
        }

        // if actively loading, make sure to adjust progress chunks for that parent and its children
        if (this.loading)
        {
            const parent = options.parentResource;
            const incompleteChildren = [];

            for (let i = 0; i < parent.children.length; ++i)
            {
                if (!parent.children[i].isComplete)
                {
                    incompleteChildren.push(parent.children[i]);
                }
            }

            const fullChunk = parent.progressChunk * (incompleteChildren.length + 1); // +1 for parent
            const eachChunk = fullChunk / (incompleteChildren.length + 2); // +2 for parent & new child

            parent.children.push(this.resources[name]);
            parent.progressChunk = eachChunk;

            for (let i = 0; i < incompleteChildren.length; ++i)
            {
                incompleteChildren[i].progressChunk = eachChunk;
            }

            this.resources[name].progressChunk = eachChunk;
        }

        // add the resource to the queue
        this._queue.push(this.resources[name]);

        return this;
    }

    /* eslint-enable require-jsdoc,valid-jsdoc */

    /**
     * Sets up a middleware function that will run *before* the
     * resource is loaded.
     * @param fn - The middleware function to register.
     * @returns The loader itself.
     */
    pre(fn: ILoaderMiddleware): this
    {
        this._beforeMiddleware.push(fn);

        return this;
    }

    /**
     * Sets up a middleware function that will run *after* the
     * resource is loaded.
     * @param fn - The middleware function to register.
     * @returns The loader itself.
     */
    use(fn: ILoaderMiddleware): this
    {
        this._afterMiddleware.push(fn);

        return this;
    }

    /**
     * Resets the queue of the loader to prepare for a new load.
     * @returns The loader itself.
     */
    reset(): this
    {
        this.progress = 0;
        this.loading = false;

        this._queue.kill();
        this._queue.pause();

        // abort all resource loads
        for (const k in this.resources)
        {
            const res = this.resources[k];

            if (res._onLoadBinding)
            {
                res._onLoadBinding.detach();
            }

            if (res.isLoading)
            {
                res.abort('loader reset');
            }
        }

        this.resources = {};

        return this;
    }

    /**
     * Starts loading the queued resources.
     * @param cb - Optional callback that will be bound to the `complete` event.
     * @returns The loader itself.
     */
    load(cb?: Loader.OnCompleteSignal): this
    {
        // #if _DEBUG
        deprecation('6.5.0', '@pixi/loaders is being replaced with @pixi/assets in the next major release.');
        // #endif

        // register complete callback if they pass one
        if (typeof cb === 'function')
        {
            this.onComplete.once(cb);
        }

        // if the queue has already started we are done here
        if (this.loading)
        {
            return this;
        }

        if (this._queue.idle())
        {
            this._onStart();
            this._onComplete();
        }
        else
        {
            // distribute progress chunks
            const numTasks = this._queue._tasks.length;
            const chunk = MAX_PROGRESS / numTasks;

            for (let i = 0; i < this._queue._tasks.length; ++i)
            {
                this._queue._tasks[i].data.progressChunk = chunk;
            }

            // notify we are starting
            this._onStart();

            // start loading
            this._queue.resume();
        }

        return this;
    }

    /**
     * The number of resources to load concurrently.
     * @default 10
     */
    get concurrency(): number
    {
        return this._queue.concurrency;
    }
    set concurrency(concurrency: number)
    {
        this._queue.concurrency = concurrency;
    }

    /**
     * Prepares a url for usage based on the configuration of this object
     * @param url - The url to prepare.
     * @returns The prepared url.
     */
    private _prepareUrl(url: string): string
    {
        const parsedUrl = parseUri(url, { strictMode: true });
        let result;

        // absolute url, just use it as is.
        if (parsedUrl.protocol || !parsedUrl.path || url.indexOf('//') === 0)
        {
            result = url;
        }
        // if baseUrl doesn't end in slash and url doesn't start with slash, then add a slash inbetween
        else if (this.baseUrl.length
            && this.baseUrl.lastIndexOf('/') !== this.baseUrl.length - 1
            && url.charAt(0) !== '/'
        )
        {
            result = `${this.baseUrl}/${url}`;
        }
        else
        {
            result = this.baseUrl + url;
        }

        // if we need to add a default querystring, there is a bit more work
        if (this.defaultQueryString)
        {
            const hash = rgxExtractUrlHash.exec(result)[0];

            result = result.slice(0, result.length - hash.length);

            if (result.indexOf('?') !== -1)
            {
                result += `&${this.defaultQueryString}`;
            }
            else
            {
                result += `?${this.defaultQueryString}`;
            }

            result += hash;
        }

        return result;
    }

    /**
     * Loads a single resource.
     * @param resource - The resource to load.
     * @param dequeue - The function to call when we need to dequeue this item.
     */
    private _loadResource(resource: LoaderResource, dequeue: () => void): void
    {
        resource._dequeue = dequeue;

        // run before middleware
        AsyncQueue.eachSeries(
            this._beforeMiddleware,
            (fn: any, next: (...args: any) => void) =>
            {
                fn.call(this, resource, () =>
                {
                    // if the before middleware marks the resource as complete,
                    // break and don't process any more before middleware
                    next(resource.isComplete ? {} : null);
                });
            },
            () =>
            {
                if (resource.isComplete)
                {
                    this._onLoad(resource);
                }
                else
                {
                    resource._onLoadBinding = resource.onComplete.once(this._onLoad, this);
                    resource.load();
                }
            },
            true
        );
    }

    /** Called once loading has started. */
    private _onStart(): void
    {
        this.progress = 0;
        this.loading = true;
        this.onStart.dispatch(this);
    }

    /** Called once each resource has loaded. */
    private _onComplete(): void
    {
        this.progress = MAX_PROGRESS;
        this.loading = false;
        this.onComplete.dispatch(this, this.resources);
    }

    /**
     * Called each time a resources is loaded.
     * @param resource - The resource that was loaded
     */
    private _onLoad(resource: LoaderResource): void
    {
        resource._onLoadBinding = null;

        // remove this resource from the async queue, and add it to our list of resources that are being parsed
        this._resourcesParsing.push(resource);
        resource._dequeue();

        // run all the after middleware for this resource
        AsyncQueue.eachSeries(
            this._afterMiddleware,
            (fn: any, next: any) =>
            {
                fn.call(this, resource, next);
            },
            () =>
            {
                resource.onAfterMiddleware.dispatch(resource);

                this.progress = Math.min(MAX_PROGRESS, this.progress + resource.progressChunk);
                this.onProgress.dispatch(this, resource);

                if (resource.error)
                {
                    this.onError.dispatch(resource.error, this, resource);
                }
                else
                {
                    this.onLoad.dispatch(this, resource);
                }

                this._resourcesParsing.splice(this._resourcesParsing.indexOf(resource), 1);

                // do completion check
                if (this._queue.idle() && this._resourcesParsing.length === 0)
                {
                    this._onComplete();
                }
            },
            true
        );
    }

    static _plugins: Array<ILoaderPlugin> = [];
    private static _shared: Loader;
    /**
     * If this loader cannot be destroyed.
     * @default false
     */
    private _protected: boolean;

    /** Destroy the loader, removes references. */
    public destroy(): void
    {
        if (!this._protected)
        {
            this.reset();
        }
    }

    /** A premade instance of the loader that can be used to load resources. */
    public static get shared(): Loader
    {
        let shared = Loader._shared;

        if (!shared)
        {
            shared = new Loader();
            shared._protected = true;
            Loader._shared = shared;
        }

        return shared;
    }

    /**
     * Use the {@link PIXI.extensions.add} API to register plugins.
     * @deprecated since 6.5.0
     * @param plugin - The plugin to add
     * @returns Reference to PIXI.Loader for chaining
     */
    public static registerPlugin(plugin: ILoaderPlugin): typeof Loader
    {
        // #if _DEBUG
        deprecation('6.5.0', 'Loader.registerPlugin() is deprecated, use extensions.add() instead.');
        // #endif

        extensions.add({
            type: ExtensionType.Loader,
            ref: plugin,
        });

        return Loader;
    }
}

extensions.handle(
    ExtensionType.Loader,
    (extension) =>
    {
        const plugin = extension.ref as unknown as ILoaderPlugin;

        Loader._plugins.push(plugin);
        plugin.add?.();
    },
    (extension) =>
    {
        const plugins = Loader._plugins;
        const plugin = extension.ref as unknown as ILoaderPlugin;
        const index = plugins.indexOf(plugin);

        if (index !== -1)
        {
            plugins.splice(index, 1);
        }
    }
);

Loader.prototype.add = function add(this: Loader, name: any, url?: any, options?: any, callback?: any): Loader
{
    // special case of an array of objects or urls
    if (Array.isArray(name))
    {
        for (let i = 0; i < name.length; ++i)
        {
            this.add((name as any)[i]);
        }

        return this;
    }

    // if an object is passed instead of params
    if (typeof name === 'object')
    {
        options = name;
        callback = (url as any) || options.callback || options.onComplete;
        url = options.url;
        name = options.name || options.key || options.url;
    }

    // case where no name is passed shift all args over by one.
    if (typeof url !== 'string')
    {
        callback = options as any;
        options = url;
        url = name;
    }

    // now that we shifted make sure we have a proper url.
    if (typeof url !== 'string')
    {
        throw new Error('No url passed to add resource to loader.');
    }

    // options are optional so people might pass a function and no options
    if (typeof options === 'function')
    {
        callback = options;
        options = null;
    }

    return this._add(name, url, options, callback);
};

// eslint-disable-next-line @typescript-eslint/no-namespace
namespace Loader
{
    /**
     * When the resource starts to load.
     * @param resource - The resource that the event happened on.
     */
    export type OnStartSignal = (loader: Loader) => void;
    /**
     * When the progress changes the loader and resource are dispatched.
     * @param loader - The loader the progress is advancing on.
     * @param resource - The resource that has completed or failed to cause the progress to advance.
     */
    export type OnProgressSignal = (loader: Loader, resource: LoaderResource) => void;
    /**
     * When a load completes without error the loader and resource are dispatched.
     * @param loader - The loader that has started loading resources.
     * @param resource - The resource that has completed.
     */
    export type OnLoadSignal = (loader: Loader, resource: LoaderResource) => void;
    /**
     * When the loader starts loading resources it dispatches this callback.
     * @param loader - The loader that has started loading resources.
     */
    export type OnCompleteSignal = (loader: Loader, resources: Dict<LoaderResource>) => void;
    /**
     * When an error occurs the loader and resource are dispatched.
     * @param loader - The loader the error happened in.
     * @param resource - The resource that caused the error.
     */
    export type OnErrorSignal = (error: Error, loader: Loader, resource: LoaderResource) => void;
}

export { Loader };

/**
 * Plugin to be installed for handling specific Loader resources.
 * @property {Function} add - Function to call immediate after registering plugin.
 * @property {Function} pre - Middleware function to run before load, the
 *           arguments for this are `(resource, next)`
 * @property {Function} use - Middleware function to run after load, the
 *           arguments for this are `(resource, next)`
 */
export interface ILoaderPlugin
{
    /** Function to call immediate after registering plugin. */
    add?(): void;

    /**
     * Middleware function to run before load
     * @param {LoaderResource} resource - resource
     * @param {LoaderResource} next - next middleware
     */
    pre?(resource: LoaderResource, next: (...args: any[]) => void): void;

    /**
     * Middleware function to run after load
     * @param {LoaderResource} resource - resource
     * @param {LoaderResource} next - next middleware
     */
    use?(resource: LoaderResource, next: (...args: any[]) => void): void;
}
