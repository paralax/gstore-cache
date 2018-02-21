'use strict';

const ds = require('@google-cloud/datastore')();
const chai = require('chai');
const sinon = require('sinon');

const gstoreCache = require('../lib');
const { datastore, string } = require('../lib/utils');
const { keys, entities } = require('./mocks/datastore');
const StoreMock = require('./mocks/cache-store');

const { expect, assert } = chai;

describe('gstoreCache.keys', () => {
    let gsCache;
    let cacheManager;
    let keyToString;

    const [key1, key2, key3] = keys;
    const [entity1, entity2, entity3] = entities;

    const methods = {
        fetchHandler() {
            return Promise.resolve();
        },
    };

    beforeEach(done => {
        gsCache = gstoreCache.init({ datastore: ds });

        const onReady = () => {
            keyToString = key => gsCache.config.cachePrefix.keys + datastore.dsKeyToString(key);
            ({ cacheManager } = gsCache);
            gsCache.removeListener('ready', onReady);
            done();
        };

        gsCache.on('ready', onReady);
    });

    afterEach(() => {
        if (methods.fetchHandler.restore) {
            methods.fetchHandler.restore();
        }
        gsCache.removeAllListeners();
    });

    describe('wrap()', () => {
        it('should get entity from cache (1)', () => {
            sinon.spy(methods, 'fetchHandler');
            const value = { name: string.random() };
            cacheManager.set(keyToString(key1), value);

            return gsCache.keys.wrap(key1, methods.fetchHandler).then(result => {
                expect(methods.fetchHandler.called).equal(false);
                expect(result.name).equal(value.name);
                expect(result[ds.KEY]).equal(key1);
            });
        });

        it('should get entity from cache (2)', () => {
            sinon.spy(methods, 'fetchHandler');
            gsCache.config.global = false;
            cacheManager.mset(keyToString(key1), entity1, keyToString(key2), entity2);

            return gsCache.keys.wrap([key1, key2], { cache: true }, methods.fetchHandler).then(results => {
                expect(methods.fetchHandler.called).equal(false);
                expect(results[0].name).equal('John');
                expect(results[1].name).equal('Mick');
                expect(results[0][ds.KEY]).equal(key1);
                expect(results[1][ds.KEY]).equal(key2);
            });
        });

        it('should *not* get entity from cache (1)', () => {
            sinon.stub(methods, 'fetchHandler').resolves([]);
            gsCache.config.global = false;
            cacheManager.set(keyToString(key1), entity1);

            return gsCache.keys.wrap(key1, methods.fetchHandler).then(() => {
                expect(methods.fetchHandler.called).equal(true);
            });
        });

        it('should *not* get entity from cache (2)', () => {
            sinon.stub(methods, 'fetchHandler').resolves([]);
            cacheManager.set(keyToString(key1), entity1);

            return gsCache.keys.wrap(key1, { cache: false }, methods.fetchHandler).then(() => {
                expect(methods.fetchHandler.called).equal(true);
            });
        });

        it('should *not* get entity from cache (3)', () => {
            // When ttl is set to "-1" don't cache

            cacheManager.set(keyToString(key1), entity1);
            sinon.spy(methods, 'fetchHandler');
            const copyConfig = gsCache.config.ttl;
            gsCache.config.ttl = Object.assign({}, gsCache.config.ttl, { keys: -1 });

            return gsCache.keys.wrap(key1, methods.fetchHandler).then(() => {
                expect(methods.fetchHandler.called).equal(true);
                gsCache.config.ttl = copyConfig;
            });
        });

        it('should get entity from fetchHandler', () => {
            sinon.stub(methods, 'fetchHandler').resolves(entity3);

            return gsCache.keys.wrap(key3, methods.fetchHandler).then(result => {
                expect(methods.fetchHandler.called).equal(true);
                expect(result.name).equal('Carol');

                return cacheManager.get(keyToString(key3)).then(cacheResponse => {
                    expect(cacheResponse.name).equal('Carol');
                });
            });
        });

        it('should get entity from *default* fetchHandler', () => {
            sinon.stub(ds, 'get').resolves(entity3);

            return gsCache.keys.wrap(key3, { cache: true }).then(result => {
                expect(ds.get.called).equal(true);
                expect(result.name).equal('Carol');

                return cacheManager.get(keyToString(key3)).then(cacheResponse => {
                    expect(cacheResponse.name).equal('Carol');
                });
            });
        });

        it('should set the TTL from config (1)', () => {
            sinon.spy(gsCache.cacheManager, 'mset');
            sinon.stub(methods, 'fetchHandler').resolves(entity1);

            return gsCache.keys.wrap(key1, methods.fetchHandler).then(() => {
                assert.ok(gsCache.cacheManager.mset.called);
                const { args } = gsCache.cacheManager.mset.getCall(0);
                expect(args[2].ttl).equal(600);
                gsCache.cacheManager.mset.restore();
            });
        });

        it('should set the TTL from config (2)', () => {
            // When not all keys in cache
            cacheManager.set(keyToString(key1), entity1);
            sinon.spy(gsCache.cacheManager, 'mset');
            sinon.stub(methods, 'fetchHandler').resolves(entity1);

            return gsCache.keys.wrap([key1, key2], methods.fetchHandler).then(() => {
                assert.ok(gsCache.cacheManager.mset.called);
                const { args } = gsCache.cacheManager.mset.getCall(0);
                expect(args[2].ttl).equal(600);
                gsCache.cacheManager.mset.restore();
            });
        });

        it('should set ttl dynamically when multistore', done => {
            const memoryCache = StoreMock();
            const redisCache = StoreMock('redis');

            gsCache = gstoreCache.init({
                config: {
                    stores: [memoryCache, redisCache],
                    ttl: {
                        stores: {
                            memory: {
                                keys: 1357,
                            },
                            redis: {
                                keys: 2468,
                            },
                        },
                    },
                },
            });

            const onReady = () => {
                gsCache.removeAllListeners();

                sinon.spy(gsCache.cacheManager, 'mset');
                sinon.spy(memoryCache.store, 'set');
                sinon.spy(redisCache.store, 'set');
                sinon.stub(methods, 'fetchHandler').resolves(entity1);

                return gsCache.keys.wrap(key1, methods.fetchHandler).then(() => {
                    const options = gsCache.cacheManager.mset.getCall(0).args[2];
                    const optMemory = memoryCache.store.set.getCall(0).args[2];
                    const optRedis = redisCache.store.set.getCall(0).args[2];

                    expect(typeof options.ttl).equal('function');
                    expect(optMemory.ttl).equal(1357);
                    expect(optRedis.ttl).equal(2468);

                    gsCache.deleteCacheManager(() => {
                        memoryCache.store.set.restore();
                        redisCache.store.set.restore();
                        done();
                    });
                });
            };

            gsCache.on('ready', onReady);
        });

        it('should prime the cache after fetch', () => {
            sinon.stub(methods, 'fetchHandler').resolves([entity1, entity2]);

            return gsCache.keys.wrap([key1, key2], methods.fetchHandler).then(() =>
                cacheManager.mget(keyToString(key1), keyToString(key2)).then(results => {
                    expect(results[0].name).equal('John');
                    expect(results[1].name).equal('Mick');
                })
            );
        });

        it('should get entities from cache + fetch', () => {
            cacheManager.set(keyToString(key1), entity1);
            cacheManager.set(keyToString(key2), entity2);

            sinon.stub(methods, 'fetchHandler').resolves(entity3);

            return gsCache.keys.wrap([key1, key2, key3], methods.fetchHandler).then(results => {
                expect(methods.fetchHandler.called).equal(true);
                expect(results[0].name).equal('John');
                expect(results[1].name).equal('Mick');
                expect(results[2].name).equal('Carol');

                expect(results[0][ds.KEY]).equal(key1);
                expect(results[1][ds.KEY]).equal(key2);
                expect(results[2][ds.KEY]).equal(key3);
            });
        });

        it('should return "null" for fetch not found ("ERR_ENTITY_NOT_FOUND")', () => {
            const error = new Error('not found');
            error.code = 'ERR_ENTITY_NOT_FOUND';

            cacheManager.set(keyToString(key1), entity1);
            sinon.stub(methods, 'fetchHandler').returns(Promise.reject(error));

            return gsCache.keys.wrap([key1, key2], methods.fetchHandler).then(result => {
                expect(result[0].name).equal('John');
                expect(result[1]).equal(null);
            });
        });

        it('should buble up the error from the fetch (1)', done => {
            const error = new Error('Houston we got an error');

            sinon.stub(methods, 'fetchHandler').rejects(error);

            gsCache.keys.wrap(key1, methods.fetchHandler).catch(err => {
                expect(err.message).equal('Houston we got an error');
                done();
            });
        });

        it('should bubble up the error from the fetch (2)', done => {
            const error = new Error('Houston we got an error');
            cacheManager.set(keyToString(key1), entity1);
            sinon.stub(methods, 'fetchHandler').rejects(error);

            gsCache.keys.wrap([key1, key2], methods.fetchHandler).catch(err => {
                expect(err.message).equal('Error: Houston we got an error');
                done();
            });
        });
    });

    describe('get()', () => {
        it('should get key from cache', () => {
            const value = { name: 'john' };
            return gsCache.keys.set(key1, value).then(() =>
                gsCache.keys.get(key1).then(res => {
                    expect(res).deep.equal(value);
                })
            );
        });

        it('should return undefined if no entity found', () =>
            gsCache.keys.get(key1).then(res => {
                expect(typeof res).equal('undefined');
            }));

        it('should add KEY Symbol to response from cache', () => {
            const value = { name: 'john' };
            return gsCache.keys.set(key1, value).then(() =>
                gsCache.keys.get(key1).then(res => {
                    assert.ok(!Array.isArray(res));
                    expect(res).include(value);
                    expect(res[ds.KEY]).equal(key1);
                })
            );
        });

        it('should get multiple keys from cache', () => {
            const value1 = { name: string.random() };
            const value2 = { name: string.random() };
            return gsCache.keys.set(key1, value1, key2, value2).then(() =>
                gsCache.keys.mget(key1, key2).then(res => {
                    expect(res[0]).deep.equal(value1);
                    expect(res[1]).deep.equal(value2);
                    expect(res[0][ds.KEY]).equal(key1);
                    expect(res[1][ds.KEY]).equal(key2);
                })
            );
        });
    });

    describe('set()', () => {
        it('should add key to cache', () => {
            const value = { name: 'john' };
            sinon.spy(gsCache, 'set');
            return gsCache.keys.set(key1, value).then(result => {
                assert.ok(gsCache.set.called);
                const { args } = gsCache.set.getCall(0);
                expect(args[0]).equal(keyToString(key1));
                expect(result.name).equal('john');
            });
        });

        it('should set the TTL from config', () => {
            sinon.spy(gsCache, 'set');
            return gsCache.keys.set(key1, entity1).then(() => {
                const { args } = gsCache.set.getCall(0);
                expect(args[2].ttl).equal(600);
            });
        });
    });

    describe('mset()', () => {
        it('should add multiple keys to cache', () => {
            const value1 = { name: 'john' };
            const value2 = { name: 'mick' };
            sinon.spy(gsCache, 'mset');

            return gsCache.keys.mset(key1, value1, key2, value2).then(result => {
                assert.ok(gsCache.mset.called);
                const { args } = gsCache.mset.getCall(0);
                expect(args[0]).equal(keyToString(key1));
                expect(args[1]).equal(value1);
                expect(args[2]).equal(keyToString(key2));
                expect(args[3]).equal(value2);
                expect(result).include.members([value1, value2]);
            });
        });

        it('should set the TTL from config', () => {
            sinon.spy(gsCache, 'mset');

            return gsCache.keys.mset(key1, {}, key2, {}).then(() => {
                const { args } = gsCache.mset.getCall(0);
                expect(args[4].ttl).equal(600);
            });
        });
    });

    describe('del()', () => {
        it('should delete 1 key from cache', () => {
            sinon.spy(gsCache, 'del');
            return gsCache.keys.del(key1).then(() => {
                assert.ok(gsCache.del.called);
                const { args } = gsCache.del.getCall(0);
                expect(args[0]).deep.equal([keyToString(key1)]);
            });
        });

        it('should delete multiple keys from cache', () => {
            sinon.spy(gsCache, 'del');
            return gsCache.keys.del(key1, key2, key3).then(() => {
                assert.ok(gsCache.del.called);
                const { args } = gsCache.del.getCall(0);
                expect(args[0][0]).deep.equal(keyToString(key1));
                expect(args[0][1]).deep.equal(keyToString(key2));
                expect(args[0][2]).deep.equal(keyToString(key3));
            });
        });
    });
});
