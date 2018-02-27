'use strict';

const arrify = require('arrify');
const utils = require('./utils');

const { dsQueryToString } = utils.datastore;
const { is } = utils;
const { getTTL } = utils.ttl;

module.exports = cache => {
    let _this;

    const addCachePrefixKeys = key => cache.config.cachePrefix.queries + key;
    const queryToString = key => addCachePrefixKeys(dsQueryToString(key));

    /**
     * Add the Datastore KEY from the entities Symbol to a "__dsKey__" property
     * to be able to stringify it and save it in Redis.
     * @param {Array<Datastore Entities>} _entities returned by Datastore
     */
    const marshalKeys = _entities => {
        let entities = arrify(_entities);
        entities = entities.map(_entity => {
            const entity = Object.assign({}, _entity, { __dsKey__: _entity[cache.ds.KEY] });
            return entity;
        });
        return Array.isArray(_entities) ? entities : entities[0];
    };

    /**
     * Reads the __dsKey__ prop on the entities.
     * If it is found, set is as datastore.KEY Symbol and deletes it.
     *
     * @param {Array<Entities>} _entities returned by the cache
     */
    const unMarshalKeys = _entities => {
        let entities = arrify(_entities);
        entities = entities.map(_entity => {
            if (!_entity.__dsKey__) {
                return _entity;
            }
            const entity = Object.assign({}, _entity, { [cache.ds.KEY]: _entity.__dsKey__ });
            delete entity.__dsKey__;
            return entity;
        });
        return Array.isArray(_entities) ? entities : entities[0];
    };

    /**
     * When a Redis Client is present we save the response of the Query to cache
     * and we also add its the cache key to a Set of Queries for the Entity Kind.
     * If later on the entity kind is modified or deleted, we can then easily remove
     * all the queries cached for that Entiy Kind with "cleanQueriesEntityKind()" below
     */
    const cacheQueryEntityKind = (queryKey, value, _entityKind, options = {}) =>
        new Promise((resolve, reject) => {
            if (!cache.redisClient) {
                return reject(new Error('No Redis Client found.'));
            }

            const entityKind = arrify(_entityKind);
            const keysSetsQueries = entityKind.map(kind => cache.config.cachePrefix.queries + kind);

            return cache.redisClient
                .multi([
                    ...keysSetsQueries.map(keySet => ['sadd', keySet, queryKey]),
                    options.ttl
                        ? ['setex', queryKey, options.ttl, JSON.stringify(value)]
                        : ['set', queryKey, JSON.stringify(value)],
                ])
                .exec((err, response) => {
                    if (err) {
                        return reject(err);
                    }
                    return resolve(response);
                });
        });

    /**
     * Remove all the queries in cache for an Entity Kind
     * This will remove from Redis all the queries saved
     * in our <EntityKind> Set
     */
    const cleanQueriesEntityKind = _entityKinds =>
        new Promise((resolve, reject) => {
            if (!cache.redisClient) {
                return reject(new Error('No Redis Client found.'));
            }

            const entityKinds = arrify(_entityKinds);

            /**
             * Get the list of Redis Keys for each EntiyKind Set
             */
            const setsQueries = entityKinds.map(entityKind => cache.config.cachePrefix.queries + entityKind);

            return cache.redisClient.multi([...setsQueries.map(set => ['smembers', set])]).exec((err, response) => {
                if (err) {
                    return reject(err);
                }

                const setsMembers = response.reduce((acc, members) => {
                    if (members === null) {
                        return acc;
                    }
                    return [...acc, ...members];
                }, []);
                const keysToDelete = new Set([...setsMembers, ...setsQueries]);

                return cache.redisClient.del(Array.from(keysToDelete), (errDel, res) => {
                    if (errDel) {
                        return reject(errDel);
                    }
                    return resolve(res);
                });
            });
        });

    /**
     * Get a Query from the Cache
     * If it is not found, fetch it and then prime the cache
     */
    const wrap = (query, ...args) => {
        let fetchHandler = args.length > 1 ? args[1] : args[0];

        if (typeof fetchHandler !== 'function') {
            /**
             * If no fetchHandler is passed, defaults to query.run()
             */
            fetchHandler = query.run.bind(query);
        }
        const options = is.object(args[0]) ? args[0] : {};
        options.ttl = getTTL(cache, options, 'queries');

        const queryKey = queryToString(query);

        return cache.cacheManager.get(queryKey, options).then(onResult);

        function onResult(resultCached) {
            if (typeof resultCached === 'undefined') {
                /**
                 * No cache we need to run the Query
                 */
                return fetchHandler(query).then(resultFetched => {
                    if (typeof cache.redisClient !== 'undefined') {
                        // If there is a Redis Client we will save the Query
                        // and link it to an Entity Kind Redis "Set"

                        // If ttl is a function call it
                        const redisOptions =
                            typeof options.ttl === 'function'
                                ? Object.assign({}, options, { ttl: options.ttl(null, 'redis') })
                                : options;

                        // Add the KEY Symbol of each entity in a __dsKey__ prop
                        const entities = marshalKeys(resultFetched[0]);

                        const cacheHandlers = [
                            _this.cacheQueryEntityKind(
                                queryKey,
                                [entities, resultFetched[1]],
                                query.kinds[0],
                                redisOptions
                            ),
                        ];

                        // If we have a cacheManager instante without the Redis Store
                        // we also save the query data in it.
                        if (cache.cacheManagerNoRedis) {
                            options.cacheManager = cache.cacheManagerNoRedis;
                            cacheHandlers.push(cache.primeCache(queryKey, resultFetched, options));
                        }

                        return Promise.all(cacheHandlers).then(() => Promise.resolve(resultFetched));
                    }

                    // Prime the cache
                    return cache.primeCache(queryKey, resultFetched, options);
                });
            }

            return resultCached;
        }
    };

    const mget = (..._keys) => {
        const isMultiple = _keys.length > 1;
        const keys = _keys.map(queryToString);

        const onResponse = _response => {
            if (typeof _response === 'undefined') {
                return _response;
            }

            const response = _response.filter(r => typeof r !== 'undefined');

            if (response.length === 0) {
                return response;
            }

            return isMultiple
                ? response.map(r => [unMarshalKeys(r[0]), r[1]])
                : [unMarshalKeys(response[0]), response[1]];
        };

        if (keys.length === 1) {
            return cache.get(keys[0]).then(onResponse);
        }

        return cache.mget(...keys).then(onResponse);
    };

    const get = mget;

    const setWithKind = (query, queryData, _options, redisOptions) => {
        const queryKey = queryToString(query);
        const options = Object.assign({}, _options);

        /**
         * Handlers to save the cache.
         * List of promises for Promise.all
         */
        const cacheHandlers = [];

        // Save the KEY Symbol of each entity in a __dsKey__ prop
        const entities = marshalKeys(queryData[0]);

        // Cache the Query by EntityKind
        cacheHandlers.push(cacheQueryEntityKind(queryKey, [entities, queryData[1]], query.kinds[0], redisOptions));

        // Add the Query in NonRedis Caches
        if (cache.cacheManagerNoRedis) {
            options.cacheManager = cache.cacheManagerNoRedis;
            cacheHandlers.push(cache.primeCache(queryKey, queryData, options));
        }

        return Promise.all(cacheHandlers).then(() => [queryData]);
    };

    const msetWithKind = (keysValues, _options, redisOptions) => {
        /**
         * Handlers to save the cache.
         * List of promises for Promise.all
         */
        const cacheHandlers = [];

        const length = keysValues.length * 0.5;
        const response = [];
        const options = Object.assign({}, _options);

        for (let i = 0; i < length; i += 1) {
            const index = i + i * 1; // eslint-disable-line
            const query = keysValues[index];
            const queryKey = queryToString(query);
            const queryData = keysValues[index + 1];
            response.push(queryData);

            // Save the KEY Symbol of each entity in a __dsKey__ prop
            const entities = marshalKeys(queryData[0]);
            const metaQuery = queryData[1];

            // Cache the Query by EntityKind
            cacheHandlers.push(
                _this.cacheQueryEntityKind(queryKey, [entities, metaQuery], query.kinds[0], redisOptions)
            );

            // Add the Query in NonRedis Caches
            if (cache.cacheManagerNoRedis) {
                options.cacheManager = cache.cacheManagerNoRedis;
                cacheHandlers.push(cache.primeCache(queryKey, [entities, metaQuery], options));
            }
        }

        return Promise.all(cacheHandlers).then(() => response);
    };

    const mset = (...keysValues) => {
        let options = keysValues.length % 2 > 0 ? keysValues.pop() : {};
        options = { ttl: getTTL(cache, options, 'queries') };

        /**
         * If there is a redisClient we save the query in a Redis Set of the Query Entity Kind.
         */
        if (typeof cache.redisClient !== 'undefined') {
            // If ttl value is a function call it
            const redisOptions =
                typeof options.ttl === 'function'
                    ? Object.assign({}, options, { ttl: options.ttl(null, 'redis') })
                    : options;

            if (keysValues.length === 2) {
                const [query, queryData] = keysValues;
                return setWithKind(query, queryData, options, redisOptions);
            }

            return msetWithKind(keysValues, options, redisOptions);
        }

        // Convert Datastore Queries to unique string ids
        const args = keysValues.map((kv, i) => {
            if (i % 2 === 0) {
                return queryToString(kv);
            }
            return kv;
        });

        if (args.length === 2) {
            return cache.set(args[0], args[1], options);
        }
        return cache.mset(...args, options).then(() => {
            // The reponse is the odd index from the keysValues
            const response = args.filter((v, i) => i % 2 > 0);
            return response;
        });
    };

    const set = mset;

    const del = (...keys) => cache.del(keys.map(k => queryToString(k)));

    /**
     * We save the object reference in a "_this" variable
     * for easier test spying.
     */
    _this = {
        cacheQueryEntityKind,
        cleanQueriesEntityKind,
        wrap,
        get,
        mget,
        set,
        mset,
        del,
    };
    return _this;
};
