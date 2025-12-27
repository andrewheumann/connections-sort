const Tesseract = require('tesseract.js')
const { createCanvas, loadImage } = require('canvas')
const fs = require('fs')

const imagePath = '/Users/andrewheumann/Downloads/IMG_1029.PNG'

const expected = [
  'CREDIT', 'VILLAGER', 'CALLING', 'FIRST',
  'BUSINESS', 'NAME', 'REPORT', 'NAMESAKE',
  'DECIDER', 'PREMIUM', 'CRAFT', 'ECONOMY',
  'LINE', 'CITE', 'TRADE', 'REFERENCE'
]

async function cropToGrid(imagePath) {
  const img = await loadImage(imagePath)

  // iPhone screenshot of Connections - grid is roughly in middle
  // Estimate: grid starts around 20% from top, ends around 70%
  // And horizontally from about 3% to 97%
  const startY = Math.floor(img.height * 0.22)
  const endY = Math.floor(img.height * 0.68)
  const startX = Math.floor(img.width * 0.02)
  const endX = Math.floor(img.width * 0.98)

  const width = endX - startX
  const height = endY - startY

  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')

  ctx.drawImage(img, startX, startY, width, height, 0, 0, width, height)

  return { canvas, ctx, width, height }
}

async function processWithThreshold(canvas, ctx, threshold, invert = false) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]

    const lum = 0.299 * r + 0.587 * g + 0.114 * b

    let isLight = lum > threshold
    if (invert) isLight = !isLight

    if (isLight) {
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
    } else {
      data[i] = 0
      data[i + 1] = 0
      data[i + 2] = 0
    }
  }

  const newCanvas = createCanvas(canvas.width, canvas.height)
  const newCtx = newCanvas.getContext('2d')
  newCtx.putImageData(imageData, 0, 0)
  return newCanvas.toBuffer('image/png')
}

async function testWithSettings(name, imageData, params = {}) {
  const worker = await Tesseract.createWorker('eng')

  if (Object.keys(params).length > 0) {
    await worker.setParameters(params)
  }

  const result = await worker.recognize(imageData)

  const text = result.data.text.toUpperCase()
  const words = text.match(/[A-Z]{2,}/g) || []

  let found = 0
  const foundWords = []
  for (const exp of expected) {
    if (words.includes(exp)) {
      found++
      foundWords.push(exp)
    }
  }

  const missing = expected.filter(e => !words.includes(e))
  console.log(`${name}: ${found}/16 | Missing: ${missing.join(', ')}`)

  await worker.terminate()
  return { found, text: result.data.text, foundWords, missing }
}

async function main() {
  console.log('=== FINAL COMBINED APPROACH ===\n')

  const { canvas, ctx, width, height } = await cropToGrid(imagePath)
  const processed = await processWithThreshold(canvas, ctx, 120, false)

  // Method 1: PSM 11 (sparse text) on full grid
  const worker1 = await Tesseract.createWorker('eng')
  await worker1.setParameters({ tessedit_pageseg_mode: '11' })
  const result1 = await worker1.recognize(processed)
  await worker1.terminate()
  const words1 = result1.data.text.toUpperCase().match(/[A-Z]{2,}/g) || []
  console.log('Method 1 (PSM 11):', words1.filter(w => expected.includes(w)))

  // Method 2: Row by row with PSM 7 (single line)
  const rowHeight = height / 4
  const words2 = []
  for (let row = 0; row < 4; row++) {
    const rowCanvas = createCanvas(width, rowHeight)
    const rowCtx = rowCanvas.getContext('2d')
    rowCtx.drawImage(canvas, 0, row * rowHeight, width, rowHeight, 0, 0, width, rowHeight)
    const rowProcessed = await processWithThreshold(rowCanvas, rowCtx, 120, false)

    const worker = await Tesseract.createWorker('eng')
    await worker.setParameters({ tessedit_pageseg_mode: '7' })
    const result = await worker.recognize(rowProcessed)
    await worker.terminate()

    const rowWords = result.data.text.toUpperCase().match(/[A-Z]{2,}/g) || []
    words2.push(...rowWords)
  }
  console.log('Method 2 (rows):', words2.filter(w => expected.includes(w)))

  // Merge results - prefer words that match expected
  const allWords = [...new Set([...words1, ...words2])]
  const foundExpected = expected.filter(e => allWords.includes(e))

  console.log('\n=== COMBINED RESULTS ===')
  console.log('Found:', foundExpected.length, '/ 16')
  console.log('Words:', foundExpected)
  console.log('Missing:', expected.filter(e => !allWords.includes(e)))

  if (foundExpected.length === 16) {
    console.log('\n✅ SUCCESS! All 16 tiles found!')
  }
}

// Export for use in browser
if (typeof module !== 'undefined') {
  module.exports = { cropToGrid, processWithThreshold }
}

main().catch(console.error)

