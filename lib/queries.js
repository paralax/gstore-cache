'use strict';

const arrify = require('arrify');
const utils = require('./utils');

const { dsQueryToString } = utils.datastore;

module.exports = cache => {
    let _this;

    const addCachePrefixKeys = key => cache.config.cachePrefix.queries + key;
    const keyToString = key => addCachePrefixKeys(dsQueryToString(key));

    /**
     * When a Redis Client is present we save the response of the Query to cache
     * and we also add its the cache key to a Set of Queries for the Entity Kind.
     * If later on the entity kind is modified or deleted, we can then easily remove
     * all the queries cached for that Entiy Kind with "cleanQueriesEntityKind()" below
     */
    const cacheQueryEntityKind = (queryKey, value, ...entityKind) =>
        new Promise((resolve, reject) => {
            const setsQueries = entityKind.map(kind => cache.config.cachePrefix.queries + kind);
            cache.redisClient
                .multi([...setsQueries.map(set => ['sadd', set, queryKey]), ['set', queryKey, JSON.stringify(value)]])
                .exec((err, response) => {
                    if (err) {
                        return reject(err);
                    }
                    return resolve(response);
                });
        });

    const cleanQueriesEntityKind = entityKind =>
        new Promise((resolve, reject) => {
            const setQueries = cache.config.cachePrefix.queries + entityKind;
            cache.redisClient.smembers(setQueries, (err, _members) => {
                if (err) {
                    return reject(err);
                }
                const members = arrify(_members);
                return cache.redisClient.del([...members, setQueries], (errDel, res) => {
                    if (errDel) {
                        return reject(errDel);
                    }
                    return resolve(res);
                });
            });
        });

    /**
     * Get a Query from the Cache
     */
    const get = (query, ...args) => {
        const fetchHandler = args.length > 1 ? args[1] : args[0];
        const options = args.length > 1 ? args[0] : {};

        let ttl;
        if (cache.config.stores.length > 1) {
            ttl = (data, storeName) => cache.config.ttl.stores[storeName].queries;
        } else {
            ttl = cache.config.ttl.queries;
        }
        options.ttl = ttl;

        if (
            !cache.cacheManager ||
            ttl === -1 ||
            options.cache === false ||
            (cache.config.global === false && options.cache !== true)
        ) {
            return fetchHandler(query);
        }

        const queryKey = keyToString(query);

        return cache.cacheManager.get(queryKey, options).then(onResult);

        function onResult(cacheResult) {
            if (typeof cacheResult === 'undefined') {
                /**
                 * No cache we need to fetch the keys
                 */
                return fetchHandler(query).then(fetchResult => {
                    const ttlQueries =
                        cache.config.ttl.stores &&
                        cache.config.ttl.stores.redis &&
                        cache.config.ttl.stores.redis.queries;
                    if (typeof cache.redisClient !== 'undefined' && ttlQueries === 0) {
                        // Save the response directly in Redis
                        return _this
                            .cacheQueryEntityKind(queryKey, fetchResult, query.kinds[0])
                            .then(() => fetchResult);
                    }
                    // Prime the cache
                    return cache.primeCache(queryKey, fetchResult, options);
                });
            }

            return cacheResult;
        }
    };

    /**
     * We save the object reference in a "_this" variable
     * for easier test spying.
     */
    _this = {
        cacheQueryEntityKind,
        cleanQueriesEntityKind,
        get,
    };
    return _this;
};