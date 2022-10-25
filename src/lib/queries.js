import Socket from "simple-websocket";
import {Apis} from "bitsharesjs-ws";
import fs from "fs";
import path from "path";

/**
 * Call an async function with a maximum time limit (in milliseconds) for the timeout
 * @param {Promise} asyncPromise An asynchronous promise to resolve
 * @param {number} timeLimit Time limit to attempt function in milliseconds
 * @returns {Promise | undefined} Resolved promise for async function call, or an error if time limit reached
 */
 const asyncCallWithTimeout = async (asyncPromise, timeLimit) => {
    let timeoutHandle;

    const timeoutPromise = new Promise((_resolve, reject) => {
        timeoutHandle = setTimeout(
            () => _resolve(null),
            timeLimit
        );
    });

    return Promise.race([asyncPromise, timeoutPromise]).then(result => {
        clearTimeout(timeoutHandle);
        return result;
    })
}

/**
 * Test a wss url for successful connection.
 * @param {String} url
 * @returns {Object}
 */
 async function _testConnection(url) {
    return new Promise(async (resolve, reject) => {
        let before = new Date();
        let beforeTS = before.getTime();
        let closing;

        /**
         * Exiting the url connection
         * @param {Boolean} connected 
         * @param {WebSocket} socket 
         * @returns 
         */
        function _exitTest(connected, socket) {
            if (closing || !connected && !socket) {
                return;
            }

            if (socket) {
                socket.destroy();
            }

            closing = true;
            if (!connected) {
                return resolve(null);
            }

            let now = new Date();
            let nowTS = now.getTime();
            return resolve({ url: url, lag: nowTS - beforeTS });
        }

        let socket = new Socket(url);

        socket.on('connect', () => {
            return _exitTest(true, socket);
        });

        socket.on('error', (error) => {
            return _exitTest(false, socket);
        });

        socket.on('close', () => {
            return _exitTest();
        });
    });
}

/**
 * Test the wss nodes, return latencies and fastest url.
 * @returns {Promise}
 */
async function testNodes(target, itr = 0) {
    return new Promise(async (resolve, reject) => {

        let currentPath = path.resolve();

        let config;
        try {
            config = await fs.readFileSync(currentPath + "/src/config/config.json");
        } catch (error) {
            console.log(error);
            return;
        }

        const _nodes = {
            BTS: JSON.parse(config).BTS.nodeList.map(node => node.url),
            BTS_TEST: JSON.parse(config).BTS_TEST.nodeList.map(node => node.url)
        };

        let urlPromises = _nodes[target].map(url => asyncCallWithTimeout(_testConnection(url), itr > 0 ? itr * 3000 : 3000))
        return Promise.all(urlPromises)
        .then((validNodes) => {
            let filteredNodes = validNodes.filter(x => x);
            if (filteredNodes.length) {
                let sortedNodes = filteredNodes.sort((a, b) => a.lag - b.lag).map(node => node.url);
                return resolve(sortedNodes);
            } else {
                if (itr > 2) {
                    console.error("No valid BTS WSS connections established; Please check your internet connection.")
                    return reject();
                }
                console.log("Couldn't establish network connections; trying again with greater timeout durations. Apologies for the delay.")
                return resolve(testNodes(target, itr + 1));
            }
        })
        .catch(error => {
            console.log(error);
        })
    });
}

/*
* Get the associated Bitshares account name from the provided account ID
* @param {String} accountId
* @returns {String}
*/
async function getAccountNames(accountIds, node, nodeFailureCallback) {
    return new Promise(async (resolve, reject) => {
        try {
            await Apis.instance(node, true).init_promise;
        } catch (error) {
            console.log(error);
            nodeFailureCallback()
            return reject();
        }

        let accountNames;
        try {
            accountNames = await Apis.instance().db_api().exec("get_objects", [accountIds]);
        } catch (error) {
            console.log(error);
            return reject();
        }

        if (!accountNames || !accountNames.length) {
            return reject();
        }

        resolve(accountNames.map(acc => {
            return {
                name: acc.name,
                id: acc.id
            }
        }));
    });
}


/**
 * Retrieve the object contents
 * @param {String} node 
 * @param {String} fromID
 * @returns 
 */
 async function fetchObjects(node, fromID, nodeFailureCallback) {
    return new Promise(async (resolve, reject) => {

        try {
            await Apis.instance(node, true).init_promise;
        } catch (error) {
            console.log(error);
            nodeFailureCallback()
            return reject();
        }

        let object;
        try {
            object = await Apis.instance().db_api().exec("list_tickets", [100, fromID])
        } catch (error) {
            console.log(error);
            return reject();
        }

        return resolve(object);
    });
}

/**
 * Get the witness signature from the block
 * @param {String} node 
 * @param {Number} blockNumber
 * @returns 
 */
 async function getBlockWitSig(node, blockNumber, nodeFailureCallback) {
    return new Promise(async (resolve, reject) => {

        try {
            await Apis.instance(node, true).init_promise;
        } catch (error) {
            console.log(error);
            nodeFailureCallback()
            return reject();
        }

        let object;
        try {
            object = await Apis.instance().db_api().exec("get_block", [blockNumber])
        } catch (error) {
            console.log(error);
            return reject();
        }

        if (!object) {
            return reject();
        }

        return resolve(object.witness_signature);
    });
}

export {
    getAccountNames,
    fetchObjects,
    testNodes,
    getBlockWitSig
};