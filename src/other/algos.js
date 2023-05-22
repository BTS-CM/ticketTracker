/**
 * Calculating the ticket value from a vector
 * @param {Vector3} inputVector 
 */
function vectorValue (inputVector) {
    let computed = inputVector.toArray().filter(x => x > 0);
    let ticketValue = 0;
    if (computed.length == 1) {
        ticketValue = computed[0];
    } else if (computed.length == 2) {
        ticketValue = computed[0] * computed[1];
    } else if (computed.length == 3) {
        ticketValue = computed[0] * computed[1] * computed[2];
    }

    return parseInt(ticketValue);
}


if (response.distributions.includes('tubes')) {
    // WIP: Doesn't work properly yet
    // 0 - 997,002,999 (extend via z axis)
    // Picks random spots from the bottom -> create tubes => get points within tubes
    let initBaseChunks = chunk(filtered_signature, 9).filter(x => x.length === 9);

    let tempA = new Vector3(0, 0, 999);
    let tempB = new Vector3(0, 0, 0);
    let maxSpine = new Line3(tempA, tempB);
    let maxSpineLength = maxSpine.distanceSq();

    let tubeTickets = [];
    for (let i = 0; i < initBaseChunks.length; i++) {
        let currentChunk = initBaseChunks[i];
        let currentTube = chunk(currentChunk, 3);

        let tubeTipPoint = new Vector3(currentTube[0], currentTube[1], currentTube[2]);
        let centralBasePoint = new Vector3(currentTube[0], currentTube[1], 999);

        let tubeSpine = new Line3(centralBasePoint, tubeTipPoint);
        let spineLength = tubeSpine.distanceSq();
        
        let tubeSteps = parseInt((spineLength / maxSpineLength) * 999);

        let currentRadius = 1;
        let chosenTubeTickets = [];
        for (let y = 0; y < tubeSteps; y++) {
            let minX = currentTube[0] - currentRadius
            let maxX = currentTube[0] + currentRadius
            let minY = currentTube[1] - currentRadius
            let maxY = currentTube[1] + currentRadius

            let minVector = new Vector3(minX, minY, 999 - y);
            let maxVector = new Vector3(maxX, maxY, 999 - y);
            
            let edgeToCenter = new Line3(minVector, maxVector);
            let radiusDistance = edgeToCenter.distanceSq(); 

            let xRange = range(minX, maxX);
            let yRange = range(minY, maxY);

            let points = xRange.map(xr => {
                return yRange.map(yr => {
                    let xyVector = new Vector3(xr, yr, 999 - y);
                    return xyVector.toArray();
                });
            })

            let flattenedPoints = [].concat.apply([], points);

            // Filter out corners outwith range of tube
            let filteredTickets = [];
            for (let g = 0; g < flattenedPoints.length; g++) {
                let inflatedVector = new Vector3(
                    parseInt(flattenedPoints[g][0]),
                    parseInt(flattenedPoints[g][1]),
                    parseInt(flattenedPoints[g][2])
                )

                let layerCenter = new Vector3(
                    parseInt(currentTube[0]),
                    parseInt(currentTube[1]),
                    parseInt(flattenedPoints[g][2])
                )

                let lineToCenter = new Line3(inflatedVector, layerCenter);

                if (lineToCenter.distanceSq() <= radiusDistance) {
                    let pointValue = vectorValue(inflatedVector);
                    filteredTickets.push(pointValue);
                }
            }

            if (filteredTickets.length) {
                chosenTubeTickets = [...chosenTubeTickets, ...filteredTickets];
            }
        }

        tubeTickets = [...tubeTickets, ...chosenTubeTickets];
    }

    console.log(`${initBaseChunks.length} tubes were created, resulting in ${tubeTickets.length} chosen tickets`);
    generatedNumbers = [...generatedNumbers, ...tubeTickets];
}