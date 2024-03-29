import fs from 'fs';
import prompts from 'prompts';
import { Vector3, Line3 } from 'three';
import blake from 'blakejs';

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
    if (chunkSize <= 0 || chunkSize > arr.length) {
        throw "Invalid chunk size"
    }

    let refArr = (arr).toLocaleString('fullwide', {useGrouping:false});

    var producedChunks = [];
    for (let i = 0; i < refArr.length; i += chunkSize) {
        producedChunks.push(refArr.slice(i, i + chunkSize));
    }

    return producedChunks.filter(x => x.length === chunkSize);
}

/**
 * Filter 0's then parseInt to avoid "010" -> 8 issue
 * @param {String} parseTarget
 */
function filterParseInt(parseTarget) {
    const vals = parseTarget.split("");

    let finalValue;
    for (let i = 0; i < vals.length; i++) {
        if (parseInt(vals[i]) > 0) {
            finalValue = parseTarget.substring(i, vals.length);
            break;
        } else {
            continue;
        }
    }

    return !finalValue ? 0 : parseInt(finalValue); 
}

/**
 * Util for generating ranges of numbers
 * @param {Number} start 
 * @param {Number} end 
 * @returns 
 */
function range (start, end) {
    return new Array(end - start).fill().map((d, i) => i + start);
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
        let computed = calculated.toArray();
        let ticketValue = 0;

        let x = computed[0];
        let y = computed[1];
        let z = computed[2];        
        ticketValue = (z * 1000000) + ((y * 1000) + x);

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
                        { title: 'Fish in a barrel', value: 'fish' },
                        { title: 'Bouncing ball', value: 'bouncing_ball' },
                        { title: 'Alien blood', value: 'alien_blood' },
                        { title: 'Average point lines', value: 'avg_point_lines' }
                    ],
                },
                {
                    type: 'number',
                    name: 'block_number',
                    message: `Enter the block number you wish to use for airdrop purposes.`
                },
                {
                    type: 'select',
                    name: 'hash',
                    message: 'What to base RNG on?',
                    choices: [
                        { title: 'Plain witness signature string', value: 'plain' },
                        { title: 'Blake2B (512 bit) hash of witness signature', value: 'Blake2B' },
                        { title: 'Blake2S (256 bit) hash of witness signature', value: 'Blake2S' }
                    ],
                },
                {
                    type: 'number',
                    name: 'reward',
                    message: `Enter a quantity of ${chain === "BTS" ? "BTS" : "TEST"} to distribute.`,
                    validate: value => value < 0 || value > (2994550000)  ? `Invalid quantity: ${value < 0 ? 'Too low' : 'Too high'}` : true
                },
                {
                    type: 'select',
                    name: 'winners',
                    message: 'Should drawn tickets always have winners?',
                    choices: [
                        { title: 'Yes, remove unallocated tickets from draw.', value: 'y_remove' },
                        { title: 'No, only allocate tickets if rightfully won.', value: 'no' }
                    ],
                },
            ],
            { onCancel }
        );
    } catch (error) {
        console.log(error);
    }
    
    if (!response || !response.distributions || !response.distributions.length || !response.block_number || !response.reward || !response.hash) {
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

    if (response.hash === 'Blake2B') { // 512 bit
        witness_signature = blake.blake2bHex(witness_signature);
    } else if (response.hash === 'Blake2S') { // 256 bit
        witness_signature = blake.blake2sHex(witness_signature);
    }

    let filtered_signature = witness_signature.split('').map((char) => {
        if (isCharNumber(char)) {
            return char; // fine
        } else {
            return char.charCodeAt(0).toString(); // swap letters for numbers
        }
    }).join('')
    
    let initialChunks = chunk(filtered_signature, 9);

    let generatedNumbers = [];
    let minVector = new Vector3(0, 0, 0);
    let maxVector = new Vector3(999, 999, 999);
    let maxDistance = minVector.distanceToSquared(maxVector);

    if (response.distributions.includes('forward')) {
        // 0 - 999,999,999
        // 24 draws
        generatedNumbers = [...generatedNumbers, ...initialChunks.map(x => filterParseInt(x))];
    }

    if (response.distributions.includes('reverse')) {
        // 0 - 999,999,999
        // 24 draws
        let reversedChunks = initialChunks.map(x => filterParseInt(x.split("").reverse().join("")));
        generatedNumbers = [...generatedNumbers, ...reversedChunks];
    }

    if (response.distributions.includes('reverse_pi')) {
        // 24 draws
        let piChunks = [];
        let reversedChunks = initialChunks.map(x => filterParseInt(x.split("").reverse().join("")));

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
            let current = parseInt(Math.sqrt(filterParseInt(initialChunks[i])));
            
            for (let y = i; y < initialChunks.length - i; y++) {
                let nextValue = parseInt(Math.sqrt(filterParseInt(initialChunks[y])));
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
        let smallerChunks = chunk(filtered_signature, 3).map(x => filterParseInt(x));
        let cubedChunks = smallerChunks.map(x => parseInt(x * x * x));
        generatedNumbers = [...generatedNumbers, ...cubedChunks];
    }

    if (response.distributions.includes('avg_point_lines')) {
        // 0 - 997,002,999 (extend via z axis)
        // Calculate the avg x/y/z coordinates -> draw lines to this from each vector => reward those on line
        let vectorChunks = initialChunks.map(initialChunk => chunk(initialChunk, 3));

        let xTally = 0;
        let yTally = 0;
        let zTally = 0;
        for (let i = 0; i < vectorChunks.length; i++) {
            let current = vectorChunks[i];
            xTally += filterParseInt(current[0]);
            yTally += filterParseInt(current[1]);
            zTally += filterParseInt(current[2]);
        }

        let avgVector = new Vector3(
            parseInt(xTally/vectorChunks.length),
            parseInt(yTally/vectorChunks.length),
            parseInt(zTally/vectorChunks.length)
        )

        let avg_lines = vectorChunks.map(vector => {
            let current = new Vector3(
                filterParseInt(vector[0]),
                filterParseInt(vector[1]),
                filterParseInt(vector[2])
            );
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
        let initHullChunks = chunk(filtered_signature, 6);

        let corrasionTickets = [];
        for (let i = 0; i < initHullChunks.length; i++) {
            let currentHullChunk = initHullChunks[i];

            let hullFragments = chunk(currentHullChunk, 3);
            let splatX = filterParseInt(hullFragments[0]);
            let splatY = filterParseInt(hullFragments[1]);

            let splatterPoint = new Vector3(splatX, splatY, 0);
            let coolingZone = new Vector3(splatX, splatY, 999);
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
        let vectors = initialChunks.map(nineDigits => {
            let vectorChunks = chunk(nineDigits, 3);
            return new Vector3(
                filterParseInt(vectorChunks[0]),
                filterParseInt(vectorChunks[1]),
                filterParseInt(vectorChunks[2])
            );
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

        let pointOfImpact = chunk(initialChunks[0], 3);

        let poiVector = new Vector3(
            filterParseInt(pointOfImpact[0]),
            filterParseInt(pointOfImpact[1]),
            filterParseInt(pointOfImpact[2])
        );

        let endVectors = response.splinter === 'yes'
                            ? initialChunks.slice(1)
                            : [initialChunks.slice(1)[0]];

        let projectileDepth = response.projectile === 'beam'
                                ? 999
                                : 333;

        let obliteratedFish = [];
        for (let y = 0; y < endVectors.length; y++) {
            let end = chunk(endVectors[y], 3);

            let endPoint = new Vector3(
                filterParseInt(end[0]),
                filterParseInt(end[1]),
                filterParseInt(end[2])
            );
            let path = new Line3(poiVector, endPoint);

            let fishInWay = parseInt((path.distanceSq() / maxDistance) * projectileDepth);

            let currentChosenTickets = extractTickets(fishInWay, path, 0.001);
            obliteratedFish = [...obliteratedFish, ...currentChosenTickets];
        }

        console.log(`1 entry point, ${endVectors.length} shards, ${obliteratedFish.length} fish obliterated 🐟🎣🍴`)
        generatedNumbers = [...generatedNumbers, ...obliteratedFish];
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

    let finalGeneratedNumbers = [];
    if (response.winners === 'y_remove') {
        finalGeneratedNumbers = [...new Set(generatedNumbers)].map(num => {
            if (num <= lastTicketVal) {
                return num;
            }
    
            let adjustedNum = num - (Math.floor(num / lastTicketVal) * lastTicketVal);
    
            return adjustedNum;
        })
    } else if (response.winners === 'no') {
        finalGeneratedNumbers = [...new Set(generatedNumbers)]; // remove duplicates
    }

    let winners = {};
    for (let i = 0; i < finalGeneratedNumbers.length; i++) {
        let currentNumber = finalGeneratedNumbers[i];
        let search = parsedJSON.find(x => currentNumber >= x.range.from && currentNumber <= x.range.to);

        if (search) {
            winners[search.id] = winners.hasOwnProperty(search.id)
                ? [...winners[search.id], currentNumber]
                : [currentNumber]
        }
    }

    let summary = [];
    for (const [key, value] of Object.entries(winners)) {
        let currentPercent = (value.length / finalGeneratedNumbers.length * 100).toFixed(5);
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