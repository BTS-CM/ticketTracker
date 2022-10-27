import fs from 'fs';
import prompts from 'prompts';
import { Vector3, Line3 } from 'three';

import {
    fetchObjects,
    getAccountNames,
    testNodes,
    getBlockWitSig
} from './src/lib/queries.js';

let ticketStore = [];
let testedNodes = [];
let selectedNode = "";

let chain;
let finished;

/**
 * Splitting arrays into chunks
 * @param {Array} arr 
 * @param {Number} chunkSize 
 * @returns {Array}
 */
function chunk(arr, chunkSize) {
    if (chunkSize <= 0) {
        throw "Invalid chunk size"
    }
    var R = [];
    for (var i=0,len=arr.length; i<len; i+=chunkSize) {
        R.push(arr.slice(i,i+chunkSize));
    }

    return R;
}

/**
 * Extract ticket numbers from multiple points along a line
 * @param {Number} quantity 
 * @param {Line3} targetLine 
 * @param {Number} increment 
 * @returns {Array}
 */
function extractTickets(quantity, targetLine, increment) {
    let chosenTickets = [];
    for (let i = 1; i <= quantity; i++) {
        let resultPlaceholder = new Vector3(0, 0, 0);
        let calculated = targetLine.at(increment * i, resultPlaceholder)
        let computed = calculated.toArray().filter(x => x > 0);
        let ticketValue = 0;
        if (computed.length == 1) {
            ticketValue = computed[0];
        } else if (computed.length == 2) {
            ticketValue = computed[0] * computed[1];
        } else if (computed.length == 3) {
            ticketValue = computed[0] * computed[1] * computed[2];
        }

        chosenTickets.push(
            parseInt(ticketValue)
        );
    }
    return chosenTickets;
}

/**
 * For identifying non-numeric chars in witness signature
 * @param {String} c 
 * @returns {Boolean}
 */
function isCharNumber(c) {
    return c >= '0' && c <= '9';
}

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


async function pickNode () {
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
        process.exit();
    }

    selectedNode = response.wss
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

    if (!selectedNode) {
        await pickNode();
    }

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
    let from = 0;
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

    let sortedLeaderboard = leaderboard.sort(function(a, b){return b.amount - a.amount});

    let finalLeaderboard = [];
    for (let i=0; i < sortedLeaderboard.length; i++) {
        let current = sortedLeaderboard[i];
        current.range = {
            from: parseInt(from),
            to: parseInt(from + current.amount)
        }
        finalLeaderboard.push(current)
        from += current.amount + 1;
    }

    fs.writeFile(
        './leaderboard.json',
        JSON.stringify(
            finalLeaderboard,
            undefined,
            4
        ),
        function(err) {
        if (err) throw err;
        console.log("🏆 Leaderboard saved to leaderboard.json");
        process.exit()
    })
}

let promptEstimate = async function () {
    let leaderboardJSON;
    try {
        leaderboardJSON = await fs.readFileSync('./leaderboard.json');
    } catch (error) {
        console.log(error);
        return;
    }
    
    let parsedJSON = JSON.parse(leaderboardJSON);
    let totalLocked = parsedJSON.map(user => user.amount).reduce((a, b) => a + b, 0);

    let response;
    try {
        response = await prompts(
            [
                {
                    type: 'number',
                    name: 'value',
                    message: `Enter a quantity of ${chain === "BTS" ? "BTS" : "TEST"} to generate estimates`,
                    validate: value => value < 0 || value > (2994550000 - totalLocked)  ? `Invalid quantity: ${value < 0 ? 'Too low' : 'Too high'}` : true
                },
                {
                    type: 'select',
                    name: 'lock_type',
                    message: 'What type of ticket are you creating?',
                    choices: [
                        {
                            title: 'Liquid funds 💰 (0x)',
                            value: 'liquid'
                        },
                        {
                            title: 'Lock for 180 days 🙂 (2x)',
                            value: 'lock_180_days'
                        },
                        {
                            title: 'Lock for 360 days 😯 (4x)',
                            value: 'lock_360_days'
                        },
                        {
                            title: 'Lock for 720 days 😲 (8x)',
                            value: 'lock_720_days'
                        },
                        {
                            title: 'Lock forever 🫡 (8x ⚠️)',
                            value: 'lock_forever'
                        }
                    ]
                },
            ],
            { onCancel }
        );
    } catch (error) {
        console.log(error);
    }
    
    if (!response || !response.value || !response.lock_type) {
        console.log('Quit estimate calculator')
        process.exit();
    }

    let calculatedValue;
    if (response.lock_type === "lock_180_days") {
        calculatedValue = response.value * 2;
    } else if (response.lock_type === "lock_360_days") {
        calculatedValue = response.value * 4;
    } else if (response.lock_type === "lock_720_days") {
        calculatedValue = response.value * 8;
    } else if (response.lock_type === "lock_forever") {
        calculatedValue = response.value * 8;
    } else {
        calculatedValue = 0;
    }

    const newTotal = totalLocked + calculatedValue;
    console.log(
        `Total locked: ${totalLocked.toFixed(5)} ${chain === "BTS" ? "BTS" : "TEST"} \n` +
        `Your input amount: ${response.value} \n` +
        `Your final calculated amount: ${calculatedValue} \n` +
        `% influence gain: ${((calculatedValue / totalLocked)*100).toFixed(5)} \n` +
        `Impact on top 10 leaderboard: \n` +
        `1. ${parsedJSON[0].percent.toFixed(5)}% -> ${((parsedJSON[0].amount / newTotal) * 100).toFixed(5)}% \n` +
        `2. ${parsedJSON[1].percent.toFixed(5)}% -> ${((parsedJSON[1].amount / newTotal) * 100).toFixed(5)}% \n` +
        `3. ${parsedJSON[2].percent.toFixed(5)}% -> ${((parsedJSON[2].amount / newTotal) * 100).toFixed(5)}% \n` +
        `4. ${parsedJSON[3].percent.toFixed(5)}% -> ${((parsedJSON[3].amount / newTotal) * 100).toFixed(5)}% \n` +
        `5. ${parsedJSON[4].percent.toFixed(5)}% -> ${((parsedJSON[4].amount / newTotal) * 100).toFixed(5)}% \n` +
        `6. ${parsedJSON[5].percent.toFixed(5)}% -> ${((parsedJSON[5].amount / newTotal) * 100).toFixed(5)}% \n` +
        `7. ${parsedJSON[6].percent.toFixed(5)}% -> ${((parsedJSON[6].amount / newTotal) * 100).toFixed(5)}% \n` +
        `8. ${parsedJSON[7].percent.toFixed(5)}% -> ${((parsedJSON[7].amount / newTotal) * 100).toFixed(5)}% \n` +
        `9. ${parsedJSON[8].percent.toFixed(5)}% -> ${((parsedJSON[8].amount / newTotal) * 100).toFixed(5)}% \n` +
        `10. ${parsedJSON[9].percent.toFixed(5)}% -> ${((parsedJSON[9].amount / newTotal) * 100).toFixed(5)}% \n`
    )

    process.exit();
}

let promptAirdrop = async function () {
    let response;
    try {
        response = await prompts(
            [
                {
                    type: 'multiselect',
                    name: 'distributions',
                    message: 'Select your prefered method(s) for generating provably fair airdrop distributions',
                    choices: [
                        { title: 'Forward chunks', value: 'forward' },
                        { title: 'Reverse chunks', value: 'reverse' },
                        { title: 'PI', value: 'pi' },
                        { title: 'Reverse PI', value: 'reverse_pi' },
                        { title: 'Cubed', value: 'cubed' },
                        { title: 'Hyper-Cubed', value: 'hypercube' },
                        { title: 'Fish in a barrel', value: 'fish' },
                        { title: 'Bouncing ball', value: 'bouncing_ball' },
                        { title: 'Alien blood', value: 'alien_blood' },
                        { title: 'Average point lines', value: 'avg_point_lines' },
                        { title: 'Depth charges', value: 'depth_charges' },
                        { title: 'Spikes', value: 'spikes'}
                    ],
                },
                {
                    type: 'number',
                    name: 'block_number',
                    message: `Enter the block number you wish to use for airdrop purposes.`
                },
                {
                    type: 'number',
                    name: 'reward',
                    message: `Enter a quantity of ${chain === "BTS" ? "BTS" : "TEST"} to distribute.`,
                    validate: value => value < 0 || value > (2994550000)  ? `Invalid quantity: ${value < 0 ? 'Too low' : 'Too high'}` : true
                }
            ],
            { onCancel }
        );
    } catch (error) {
        console.log(error);
    }
    
    if (!response || !response.distributions || !response.distributions.length || !response.block_number || !response.reward) {
        console.log('User quit the random airdrop menu');
        process.exit();
    }

    if (!testedNodes || !testedNodes.length) {
        let tested = await testNodes(chain);

        if (tested && tested.length) {
            testedNodes = tested;
        }
    }

    if (!selectedNode) {
        await pickNode();
    }

    let witness_signature;
    try {
        witness_signature = await getBlockWitSig(selectedNode, response.block_number, nodeFailureCallback);
    } catch (error) {
        console.log(error);
        process.exit();
    }

    let filtered_signature = witness_signature.split('').map((char) => {
        if (isCharNumber(char)) {
            return char; // fine
        } else {
            return char.charCodeAt(0).toString(); // swap letters for numbers
        }
    }).join('')
    
    let initialChunks = chunk(
        // 0 - 999,999,
        // 24 chunks
        (filtered_signature).toLocaleString('fullwide', {useGrouping:false}),
        9
    ).map(x => parseInt(x));

    let generatedNumbers = [];
    let minVector = new Vector3(0, 0, 0);
    let maxVector = new Vector3(999, 999, 999);
    let maxDistance = minVector.distanceToSquared(maxVector);

    if (response.distributions.includes('forward')) {
        // 0 - 999,999,999
        // 24 draws
        generatedNumbers = [...generatedNumbers, ...initialChunks];
    }

    if (response.distributions.includes('reverse')) {
        // 0 - 999,999,999
        // 24 draws
        let reversedChunks = initialChunks.map(x => parseInt(x.toString().split("").reverse().join("")));
        generatedNumbers = [...generatedNumbers, ...reversedChunks];
    }

    if (response.distributions.includes('reverse_pi')) {
        // 24 draws
        let piChunks = [];
        let reversedChunks = initialChunks.map(x => parseInt(x.toString().split("").reverse().join("")));

        for (let i = 0; i < reversedChunks.length; i++) {
            let current = parseInt(Math.sqrt(reversedChunks[i]));
            
            for (let y = i; y < reversedChunks.length - i; y++) {
                let nextValue = parseInt(Math.sqrt(reversedChunks[y]));
                piChunks.push(
                    parseInt((current * nextValue) * Math.PI)
                )
            }
        }

        generatedNumbers = [...generatedNumbers, ...piChunks];
    }

    if (response.distributions.includes('pi')) {
        // 24 draws
        let piChunks = [];
        for (let i = 0; i < initialChunks.length; i++) {
            let current = parseInt(Math.sqrt(initialChunks[i]));
            
            for (let y = i; y < initialChunks.length - i; y++) {
                let nextValue = parseInt(Math.sqrt(initialChunks[y]));
                piChunks.push(
                    parseInt((current * nextValue) * Math.PI)
                )
            }
        }

        generatedNumbers = [...generatedNumbers, ...piChunks];
    }

    if (response.distributions.includes('cubed')) {
        // 0 - 997,002,999
        // 72 draws
        let smallerChunks = chunk(
            (filtered_signature).toLocaleString('fullwide', {useGrouping:false}),
            3
        ).map(x => parseInt(x));

        let cubedChunks = smallerChunks.map(x => parseInt(x * x * x));
        generatedNumbers = [...generatedNumbers, ...cubedChunks];
    }

    // depth_charges
    if (response.distributions.includes('depth_charges')) {

    }

    // spikes
    if (response.distributions.includes('spikes')) {

    }

    if (response.distributions.includes('avg_point_lines')) {
        // 0 - 997,002,999 (extend via z axis)
        // Calculate the avg x/y/z coordinates -> draw lines to this from each vector => reward those on line
        let initChunks = chunk(
            (filtered_signature).toLocaleString('fullwide', {useGrouping:false}),
            9
        ).map(x => parseInt(x)).filter(x => x.toString().length === 9);

        let vectorChunks = initChunks.map(init => {
            return chunk(
                (init).toLocaleString('fullwide', {useGrouping:false}),
                3
            )
        })

        let xTally = 0;
        let yTally = 0;
        let zTally = 0;
        for (let i = 0; i < vectorChunks.length; i++) {
            let current = vectorChunks[i];
            xTally += parseInt(current[0]);
            yTally += parseInt(current[1]);
            zTally += parseInt(current[2]);
        }

        let avgVector = new Vector3(
            parseInt(xTally/vectorChunks.length),
            parseInt(yTally/vectorChunks.length),
            parseInt(zTally/vectorChunks.length)
        )

        let avg_lines = vectorChunks.map(vector => {
            let current = new Vector3(parseInt(vector[0]), parseInt(vector[1]), parseInt(vector[2]));
            return new Line3(current, avgVector);
        })

        let chosenTickets = [];
        for (let i = 0; i < avg_lines.length; i++) {
            let currentLine = avg_lines[i];
            let qty = parseInt((currentLine.distanceSq()/maxDistance) * 999);
            let currentChosenTickets = extractTickets(qty, currentLine, 0.001);
            chosenTickets = [...chosenTickets, ...currentChosenTickets];
        }

        console.log(`avg_point_lines: ${chosenTickets.length} tickets chosen`)
        generatedNumbers = [...generatedNumbers, ...chosenTickets];
    }

    if (response.distributions.includes('alien_blood')) {
        // 0 - 997,002,999 (extend via z axis)
        // Picks alien blood splatter spots; it burns directly down through the hull
        let initHullChunks = chunk(
            (filtered_signature).toLocaleString('fullwide', {useGrouping:false}),
            6
        ).map(x => parseInt(x)).filter(x => x.toString().length === 6);

        let corrasionTickets = [];
        for (let i = 0; i < initHullChunks.length; i++) {
            let currentHullChunk = initHullChunks[i];

            let hullFragments = chunk(
                (currentHullChunk).toLocaleString('fullwide', {useGrouping:false}),
                3
            );

            let splatterPoint = new Vector3(hullFragments[0], hullFragments[1], 0);
            let coolingZone = new Vector3(hullFragments[0], hullFragments[1], 999);
            let corrasion = new Line3(splatterPoint, coolingZone);

            let currentChosenTickets = extractTickets(999, corrasion, 0.001);
            corrasionTickets = [...corrasionTickets, ...currentChosenTickets];
        }

        console.log(`The alien bled on ${initHullChunks.length} hull tiles, resulting in ${corrasionTickets.length} melted tickets.`)
        generatedNumbers = [...generatedNumbers, ...corrasionTickets];
    }

    if (response.distributions.includes('bouncing_ball')) {
        //  0 - 997,002,999 (extend via z axis)
        //  path of ball bouncing in matrix -> pick tickets along path
        let initBarrelChunks = chunk(
            (filtered_signature).toLocaleString('fullwide', {useGrouping:false}),
            9
        ).map(x => parseInt(x)).filter(x => x.toString().length === 9);

        let vectors = initBarrelChunks.map(nineDigits => {
            let vectorChunks = chunk(
                (nineDigits).toLocaleString('fullwide', {useGrouping:false}),
                3
            );

            return new Vector3(parseInt(vectorChunks[0]), parseInt(vectorChunks[1]), parseInt(vectorChunks[2]));
        })

        let bouncingVectors = [];
        for (let i = 0; i < vectors.length; i++) {
            let currentVector = vectors[i];
            let cvArray = currentVector.toArray();

            let nextVector = vectors[i + 1];
            if (!nextVector) {
                continue;
            }

            let nvArray = nextVector.toArray();
            if (nvArray[2] <= cvArray[2]) {
                // going down
                let xAxis = (parseInt(nvArray[0]) + parseInt(cvArray[0]))/2;
                let yAxis = (parseInt(nvArray[1]) + parseInt(cvArray[1]))/2;
                
                bouncingVectors.push(
                    new Vector3(xAxis, yAxis, 0)
                );
            }
            
            bouncingVectors.push(nextVector);
        }

        let lastVector = bouncingVectors.slice(-1)[0].toArray();
        lastVector[2] = 0;
        let finalVector = new Vector3(lastVector[0], lastVector[1], lastVector[2]);
        bouncingVectors.push(finalVector); // ball falls to the ground at the end

        let pathOfBall = [];
        for (let i = 0; i < bouncingVectors.length - 1; i++) {
            // Create lines between each bounce
            let currentVector = bouncingVectors[i];
            let nextVector = bouncingVectors[i + 1];

            let distance = currentVector.distanceToSquared(nextVector);
            pathOfBall.push({
                line: new Line3(currentVector, nextVector),
                distance: distance,
                qtyPicks: distance > 0 ? parseInt((distance/maxDistance) * 999) : 0,
            });
        }

        let chosenTickets = [];
        for (let i = 0; i < pathOfBall.length; i++) {
            let currentLine = pathOfBall[i];
            let currentChosenTickets = extractTickets(currentLine.qtyPicks, currentLine.line, 0.001);
            chosenTickets = [...chosenTickets, ...currentChosenTickets];
        }

        console.log(`The ball bounced ${pathOfBall.length - 1} times, resulting in ${chosenTickets.length} chosen tickets.`)
        generatedNumbers = [...generatedNumbers, ...chosenTickets];
    }

    if (response.distributions.includes('fish')) {
        /**
         * Shooting fish in a barrel is totally fair & we can prove it.
         * The bullet hits the barrel and breaks into multiple fragments which each damage fish in their way.
         * 0 to 997,002,999
         * Could increase to 0 to 9,979,011,999 if we increase the z axis to 4 digits from 3.
         * Many draws
         */

         let response;
         try {
             response = await prompts(
                 [
                    {
                        type: 'select',
                        name: 'projectile',
                        message: 'How far should the projectile travel in the barrel of fish?',
                        choices: [
                            {
                                title: 'The projectile should pass directly from point A to point B unimpeded.',
                                value: 'beam'
                            },
                            {
                                title: 'The projectiles will slow to a halt quickly in the water.',
                                value: 'slow'
                            }
                        ]
                    },
                    {
                        type: 'select',
                        name: 'splinter',
                        message: 'Will the projectile splinter on impact?',
                        choices: [
                            {
                                title: 'Yes, it should splinter once on impact.',
                                value: 'yes'
                            },
                            {
                                title: "No, it's a solid single projectile.",
                                value: 'no'
                            }
                        ]
                    },
                 ],
                 { onCancel }
             );
         } catch (error) {
             console.log(error);
         }
         
         if (!response || !response.projectile || !response.splinter) {
             console.log('User did not shoot fish in a barrel')
             process.exit();
         }

        let initBarrelChunks = chunk(
            (filtered_signature).toLocaleString('fullwide', {useGrouping:false}),
            9
        ).map(x => parseInt(x)).filter(x => x.toString().length === 9);

        let pointOfImpact = chunk(
            (initBarrelChunks[0]).toLocaleString('fullwide', {useGrouping:false}),
            3
        ).map(x => parseInt(x));

        let poiVector = new Vector3(pointOfImpact[0], pointOfImpact[1], pointOfImpact[2]);

        let endVectors = response.splinter === 'yes'
                            ? initBarrelChunks.slice(1)
                            : [initBarrelChunks.slice(1)[0]];

        let projectileDepth = response.projectile === 'beam'
                                ? 999
                                : 333;

        let obliteratedFish = [];
        for (let y = 0; y < endVectors.length; y++) {
            let end = chunk(
                (endVectors[y]).toLocaleString('fullwide', {useGrouping:false}),
                3
            ).map(x => parseInt(x));

            let endPoint = new Vector3(end[0], end[1], end[2]);
            let path = new Line3(poiVector, endPoint);

            let fishInWay = parseInt((path.distanceSq() / maxDistance) * projectileDepth);

            let currentChosenTickets = extractTickets(fishInWay, path, 0.001);
            obliteratedFish = [...obliteratedFish, ...currentChosenTickets];
        }

        console.log(`1 entry point, ${endVectors.length} shards, ${obliteratedFish.length} fish obliterated 🐟🎣🍴`)
        generatedNumbers = [...generatedNumbers, ...obliteratedFish];
    }

    if (response.distributions.includes('hypercube')) {
        /**
         * 0 - 2,991,008,997 (just below the total of 2.994 Billion BTS)
         * 86 draws
         */
        let smallerChunks = chunk(
            (filtered_signature).toLocaleString('fullwide', {useGrouping:false}),
            5
        ).map(x => parseInt(x));

        let reversedChunks = smallerChunks.map(x => parseInt(x.toString().split("").reverse().join("")));
        
        let hyperCubeChunks = [...reversedChunks, ...smallerChunks].map(x => {
            let val = Math.sqrt(x) * Math.PI;
            return parseInt(3 * (val * val * val));
        });

        generatedNumbers = [...generatedNumbers, ...hyperCubeChunks];
    }
    
    let leaderboardJSON;
    try {
        leaderboardJSON = await fs.readFileSync('./leaderboard.json');
    } catch (error) {
        console.log(error);
        return;
    }

    let parsedJSON = JSON.parse(leaderboardJSON);
    let lastTicketVal = parsedJSON.at(-1).range.to;
    
    let fixedGeneratedNumbers = [...new Set(generatedNumbers)].map(num => {
        if (num <= lastTicketVal) {
            return num;
        }

        let adjustedNum = num - (Math.floor(num / lastTicketVal) * lastTicketVal);

        return adjustedNum;
    })

    let winners = {};
    for (let i = 0; i < fixedGeneratedNumbers.length; i++) {
        let currentNumber = fixedGeneratedNumbers[i];
        let search = parsedJSON.find(x => currentNumber >= x.range.from && currentNumber <= x.range.to);

        if (search) {
            winners[search.id] = winners.hasOwnProperty(search.id)
                ? [...winners[search.id], currentNumber]
                : [currentNumber]
        }
    }

    let summary = [];
    for (const [key, value] of Object.entries(winners)) {
        let currentPercent = (value.length / fixedGeneratedNumbers.length * 100).toFixed(5);
        summary.push({
            id: key,
            tickets: JSON.stringify(value.sort((a,b) => a-b)),
            qty: value.length,
            percent: currentPercent,
            reward: ((currentPercent/100) * response.reward ?? 0).toFixed(5)
        })
    }

    let airdropFile = {
        result: summary,
        block_number: response.block_number,
        generation_methods: response.distributions,
        total_distributed: response.reward ?? 0
    };

    fs.writeFileSync(
        './airdrop.json',
        JSON.stringify(
            airdropFile,
            undefined,
            4
        ),
        function(err) {
            if (err) throw err;
            console.log("🌦️ Saved summary of airdrop to airdrop.json");
        }
    );

    process.exit();
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

        menuOptions.push({
            title: 'Estimate ticket lock creation impact',
            value: 'estimate'
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
        process.exit();
    }

    if (response.menu === 'fetch') {
        promptFetch(1000);
    } else if (response.menu === 'airdrop') {
        promptAirdrop();
    } else if (response.menu === 'estimate') {
        promptEstimate();
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
        process.exit();
    }

    chain = response.chain;
    promptMenu();
}

promptENV();