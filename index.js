import fetch from 'node-fetch';
import fs from 'fs';
import prompts from 'prompts';

import {
    fetchObjects,
    getAccountNames,
    testNodes
} from './src/lib/queries.js';

let ticketStore = [];
let testedNodes = [];
let selectedNode = "";

let chain;
let finished;
let endID;

const onCancel = prompt => {
    console.log('rejected prompt')
}

let nodeFailureCallback = async function () {
    if (!testedNodes || !testedNodes.length) {
        // reinitialize nodes - user could be offline
        let tested = await testNodes(chain);

        if (tested && tested.length) {
            testedNodes = tested;
        }
    }
    let nodesToChange = testedNodes;
    nodesToChange.push(nodesToChange.shift()); // Moving misbehaving node to end
    testedNodes = nodesToChange;
}

function humanReadableFloat(satoshis, precision) {
    return satoshis / Math.pow(10, precision)
}

/**
 * Requesting an individual ticket from elasticsearch
 * @param {Number} id
 * @returns {Object}
 */
let fetchTickets = async function (fromID) { 
    if (finished) {
        return;
    }

    let response;
    try {
        response = await fetchObjects(
            selectedNode,
            `1.18.${fromID}`,
            nodeFailureCallback
        );
    } catch (error) {
        console.log(error);
    }

    if (response && response.length) {
        console.log(`Fetched tickets: 1.18.${fromID} to 1.18.${fromID + 100}`);
        for (let i = 0; i < response.length; i++) {
            if (!ticketStore.find(x => x.id === response[i].id)) {
                ticketStore.push(response[i]);
            } else {
                console.log(`Duplicate: ${response[i].id}`)
            }
        }
    } else {
        finished = true;
    }
}

let checkExisting = async function () {
    if (!fs.existsSync('./tickets.json')) {
        return;
    }

    let tickets;
    try {
        tickets = await fs.readFileSync('./tickets.json');
    } catch (error) {
        console.log(error);
        return;
    }
    
    if (tickets) {
        ticketStore = JSON.parse(tickets);
    }
}

/**
 * Fetch tickets from the Bitshares blockchain
 * @param {Number} limit 
 */
let promptFetch = async function (limit) {
    if (!ticketStore.length) {
        await checkExisting();
    }
    
    if (!testedNodes || !testedNodes.length) {
        let tested = await testNodes(chain);

        if (tested && tested.length) {
            testedNodes = tested;
        }
    }

    let response;
    try {
        response = await prompts(
            [
                {
                    type: 'select',
                    name: 'wss',
                    message: 'Which blockchain connection do you want to use? (sorted fastest to slowest)',
                    choices: testedNodes.map((node, i) => {
                        return {
                            title: node,
                            value: node
                        }
                    })
                },
            ],
            { onCancel }
        );
    } catch (error) {
        console.log(error);
    }
    
    if (!response || !response.wss) {
        console.log('User quit the wss menu')
        return;
    }
    selectedNode = response.wss

    let lastID = ticketStore && ticketStore.length
                    ? parseInt((ticketStore.at(-1).id).split("1.18.")[1])
                    : 0;
    
    for (let i = 0; i < Math.round(limit/10); i++) {
        if (finished) {
            break;
        }

        await fetchTickets(lastID + (i * 100));
    }

    fs.writeFile('./tickets.json', JSON.stringify(ticketStore, undefined, 4), function(err) {
        if (err) throw err;
        console.log("✅ Tickets saved to tickets.json");
    });

    // Process the file
    let filteredTickets = ticketStore.filter(x => x.current_type != "liquid")
    fs.writeFile('./lockedTickets.json', JSON.stringify(filteredTickets, undefined, 4), function(err) {
        if (err) throw err;
        console.log("🔒 Non-liquid locked tickets saved to lockedTickets.json");
    });

    let userTicketQty = {};
    let tallies = {};
    let sum = 0.00000;
    for (let i = 0; i < filteredTickets.length; i++) {
        let currentTicket = filteredTickets[i];
        let id = currentTicket.id;
        let currentAccount = currentTicket.account;
        let ticketType = currentTicket.current_type;
        let currentAmount = parseInt(currentTicket.amount.amount);

        if (ticketType === "lock_180_days") {
            currentAmount = currentAmount * 2;
        } else if (ticketType === "lock_360_days") {
            currentAmount = currentAmount * 4;
        } else if (ticketType === "lock_720_days") {
            currentAmount = currentAmount * 8;
        } else if (ticketType === "lock_forever") {
            currentAmount = currentAmount * 8;
        } else {
            currentAmount = 0;
        }
        
        sum += parseFloat(humanReadableFloat(currentAmount, 5).toFixed(5));

        if (!tallies.hasOwnProperty(currentAccount)) {
            tallies[currentAccount] = currentAmount;
            userTicketQty[currentAccount] = [id];
        } else {
            tallies[currentAccount] += currentAmount;
            userTicketQty[currentAccount].push(id);
        }
    }

    let userAccounts = Object.keys(tallies);
    let fetchedAccounts;
    try {
        fetchedAccounts = await getAccountNames(userAccounts, selectedNode, nodeFailureCallback)
    } catch (error) {
        console.log(error);
    }

    let leaderboard = [];
    for (var key of Object.keys(tallies)) {
        let currentValue = parseFloat(humanReadableFloat(parseInt(tallies[key]), 5).toFixed(5));

        let currentName;
        if (fetchedAccounts && fetchedAccounts.length) {
            currentName = fetchedAccounts.find(x => x.id === key).name;
        }

        leaderboard.push({
            id: key,
            amount: currentValue,
            name: currentName ?? '???',
            tickets: userTicketQty[key],
            percent: (currentValue/sum)*100
        })
    }

    fs.writeFile(
        './leaderboard.json',
        JSON.stringify(
            leaderboard.sort(function(a, b){return b.amount - a.amount}),
            undefined,
            4
        ),
        function(err) {
        if (err) throw err;
        console.log("🏆 Leaderboard saved to leaderboard.json");
        process.exit()
    })
}

let promptAirdrop = async function () {
    let response;
    try {
        response = await prompts(
            [
                {
                    type: 'select',
                    name: 'menu',
                    message: 'What do you want to do?',
                    choices: [
                        {
                            title: 'Compute totals from tickets',
                            value: 'compute'
                        },
                        {
                            title: 'Airdrop BTS proportionally to ticket holders',
                            value: 'proportional'
                        },
                        {
                            title: 'Randomly airdrop BTS onto a ticket holder',
                            value: 'random'
                        }
                    ]
                },
            ],
            { onCancel }
        );
    } catch (error) {
        console.log(error);
    }
    
    if (!response || !response.menu) {
        console.log('User quit the main menu')
        return;
    }

    if (response.menu === 'compute') {
        console.log('compute')
    } else if (response.menu === 'proportional') {
        console.log('proportional')
    } else if (response.menu === 'random') {
        console.log('random')
    }
}

let promptMenu = async function () {

    let menuOptions = [
        {
            title: 'Fetch tickets',
            value: 'fetch'
        }
    ];
    if (fs.existsSync('./leaderboard.json')) {
        menuOptions.push({
            title: 'Create airdrop',
            value: 'airdrop'
        });
    }

    let response;
    try {
        response = await prompts(
            [
                {
                    type: 'select',
                    name: 'menu',
                    message: 'What do you want to do?',
                    choices: menuOptions
                },
            ],
            { onCancel }
        );
    } catch (error) {
        console.log(error);
    }
    
    if (!response || !response.menu) {
        console.log('User quit the main menu')
        return;
    }

    if (response.menu === 'fetch') {
        promptFetch(1000);
    } else if (response.menu === 'airdrop') {
        promptAirdrop();
    }
}

let promptENV = async function () {
    let response;
    try {
        response = await prompts(
            [
                {
                    type: 'select',
                    name: 'chain',
                    message: 'Which bitshares blockchain do you want to use?',
                    choices: [
                        {
                            title: 'Production BTS',
                            value: 'BTS'
                        },
                        {
                            title: 'Testnet BTS_TEST',
                            value: 'BTS_TEST'
                        }
                    ]
                },
            ],
            { onCancel }
        );
    } catch (error) {
        console.log(error);
    }
    
    if (!response || !response.chain) {
        console.log('User quit the env menu')
        return;
    }

    chain = response.chain;
    promptMenu();
}

promptENV();