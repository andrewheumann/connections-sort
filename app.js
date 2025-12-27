// State
const STORAGE_KEY = 'connections-sorter-state'
let tiles = []
let draggedTile = null
let draggedIndex = null

// DOM Elements
const imageInput = document.getElementById('image-input')
const uploadSection = document.getElementById('upload-section')
const processingOverlay = document.getElementById('processing-overlay')
const processingStatus = document.getElementById('processing-status')
const gridSection = document.getElementById('grid-section')
const tilesGrid = document.getElementById('tiles-grid')
const shuffleBtn = document.getElementById('shuffle-btn')
const newImageBtn = document.getElementById('new-image-btn')

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadState()
  setupEventListeners()
})

function setupEventListeners() {
  imageInput.addEventListener('change', handleImageUpload)
  shuffleBtn.addEventListener('click', shuffleTiles)
  newImageBtn.addEventListener('click', resetToUpload)
}

// State Management
function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY)
  if (saved) {
    try {
      tiles = JSON.parse(saved)
      if (tiles && tiles.length === 16) {
        showGrid()
        renderTiles()
      }
    } catch (e) {
      console.log('Failed to load saved state:', e)
      localStorage.removeItem(STORAGE_KEY)
    }
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tiles))
}

function clearState() {
  localStorage.removeItem(STORAGE_KEY)
  tiles = []
}

// Image Upload and OCR
async function handleImageUpload(e) {
  const file = e.target.files?.[0]
  if (!file) return

  // Clear existing state when uploading new image
  clearState()

  showProcessing('Loading image...')

  try {
    const imageData = await loadImage(file)
    await extractTextFromImage(imageData)
  } catch (error) {
    console.error('Error processing image:', error)
    hideProcessing()
    alert('Failed to process image. Please try again with a clear screenshot.')
  }

  // Reset input so same file can be selected again
  imageInput.value = ''
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

// Crop to the grid area of a Connections screenshot
function cropToGrid(img) {
  // Grid is roughly in middle of iPhone screenshot
  // These values work for standard iPhone Connections screenshots
  const startY = Math.floor(img.height * 0.18)
  const endY = Math.floor(img.height * 0.62)
  const startX = Math.floor(img.width * 0.02)
  const endX = Math.floor(img.width * 0.98)

  const width = endX - startX
  const height = endY - startY

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')

  ctx.drawImage(img, startX, startY, width, height, 0, 0, width, height)

  console.log(`Crop: y=${startY}-${endY}, x=${startX}-${endX}`)

  return { canvas, ctx, width, height }
}

// Apply threshold to convert to black and white
function applyThreshold(canvas, ctx, threshold = 120) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]

    const lum = 0.299 * r + 0.587 * g + 0.114 * b

    if (lum > threshold) {
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
    } else {
      data[i] = 0
      data[i + 1] = 0
      data[i + 2] = 0
    }
  }

  const newCanvas = document.createElement('canvas')
  newCanvas.width = canvas.width
  newCanvas.height = canvas.height
  const newCtx = newCanvas.getContext('2d')
  newCtx.putImageData(imageData, 0, 0)

  return newCanvas.toDataURL('image/png')
}

// Extract a single row from the grid
function extractRow(canvas, rowIndex, totalRows = 4) {
  const rowHeight = canvas.height / totalRows
  const rowCanvas = document.createElement('canvas')
  rowCanvas.width = canvas.width
  rowCanvas.height = rowHeight
  const rowCtx = rowCanvas.getContext('2d')

  rowCtx.drawImage(
    canvas,
    0, rowIndex * rowHeight, canvas.width, rowHeight,
    0, 0, canvas.width, rowHeight
  )

  return { canvas: rowCanvas, ctx: rowCtx }
}

async function extractTextFromImage(imageData) {
  showProcessing('Initializing OCR...')

  try {
    // Load the image to get dimensions
    const img = await loadImageElement(imageData)
    console.log('Image dimensions:', img.width, 'x', img.height)

    showProcessing('Processing image...')

    // Create canvas with full image
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    ctx.drawImage(img, 0, 0)

    // Apply threshold to make text clearer
    const processedImage = applyThreshold(canvas, ctx, 140)

    showProcessing('Running OCR...')

    const worker = await Tesseract.createWorker('eng')
    const result = await worker.recognize(processedImage)
    console.log('OCR raw text:', result.data.text)
    await worker.terminate()

    // Extract all words
    const allWords = extractWordsFromText(result.data.text)
    console.log('All extracted words:', allWords)

    // Filter to valid tile words (removes UI text)
    const validTiles = allWords.filter(w => isValidTileWord(w))
    console.log('Valid tiles after filtering:', validTiles)

    // If we don't have enough, try without threshold
    if (validTiles.length < 16) {
      console.log('Not enough tiles, trying original image...')
      showProcessing('Retrying OCR...')

      const worker2 = await Tesseract.createWorker('eng')
      const result2 = await worker2.recognize(imageData)
      console.log('OCR raw text (original):', result2.data.text)
      await worker2.terminate()

      const words2 = extractWordsFromText(result2.data.text)
      const validTiles2 = words2.filter(w => isValidTileWord(w))
      console.log('Valid tiles from original:', validTiles2)

      // Merge both results
      for (const tile of validTiles2) {
        if (!validTiles.includes(tile)) {
          validTiles.push(tile)
        }
      }
      console.log('Combined tiles:', validTiles)
    }

    if (validTiles.length >= 16) {
      tiles = validTiles.slice(0, 16)
    } else if (validTiles.length > 0) {
      tiles = validTiles
      while (tiles.length < 16) {
        tiles.push(`TILE ${tiles.length + 1}`)
      }
      console.log(`Only found ${validTiles.length} tiles, padded to 16`)
    } else {
      throw new Error('Could not extract tiles from the image. Please try a clearer screenshot.')
    }

    saveState()
    hideProcessing()
    showGrid()
    renderTiles()

  } catch (error) {
    console.error('OCR Error:', error)
    throw error
  }
}

// Helper to load image as HTMLImageElement
function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// Extract words from OCR text
function extractWordsFromText(text) {
  const upperText = text.toUpperCase()
  const words = upperText.match(/[A-Z]{2,}/g) || []
  return words
}


function isValidTileWord(text) {
  if (!text || text.length === 0) return false
  if (text.length > 20) return false
  if (text.length < 2) return false  // Tile words are at least 2 chars

  // Filter out common UI text from Connections app
  const uiWords = [
    'CONNECTIONS', 'CONNECTION', 'CREATE', 'SHUFFLE', 'DESELECT', 'SUBMIT',
    'TODAY', 'ARCHIVE', 'PLAY', 'NYT', 'GAMES', 'MENU', 'GAME',
    'MISTAKES', 'REMAINING', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE',
    'NEXT', 'BACK', 'SHARE', 'RESULTS', 'VIEW', 'ALL', 'OF',
    'GROUPS', 'GROUP', 'CORRECT', 'INCORRECT', 'GUESS', 'GUESSES',
    'SETTINGS', 'HELP', 'HOW', 'TO', 'THE', 'AND', 'FOR', 'WITH',
    'YOUR', 'YOU', 'ARE', 'WAS', 'WERE', 'BEEN', 'BEING',
    'AM', 'PM', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'
  ]

  if (uiWords.includes(text)) return false

  // Filter out time patterns like "11:29"
  if (/^\d{1,2}:\d{2}$/.test(text)) return false

  // Filter out pure numbers
  if (/^\d+$/.test(text)) return false

  // Must have at least one letter
  if (!/[A-Z]/.test(text)) return false

  // Filter out very short common words that aren't likely tiles
  const shortCommonWords = ['A', 'I', 'AN', 'AS', 'AT', 'BE', 'BY', 'DO', 'GO', 'HE', 'IF', 'IN', 'IS', 'IT', 'ME', 'MY', 'NO', 'ON', 'OR', 'SO', 'UP', 'US', 'WE']
  if (shortCommonWords.includes(text)) return false

  return true
}

// UI State
function showProcessing(message) {
  processingStatus.textContent = message
  processingOverlay.classList.remove('hidden')
  uploadSection.classList.add('hidden')
  gridSection.classList.add('hidden')
}

function hideProcessing() {
  processingOverlay.classList.add('hidden')
}

function showGrid() {
  uploadSection.classList.add('hidden')
  gridSection.classList.remove('hidden')
}

function resetToUpload() {
  clearState()
  gridSection.classList.add('hidden')
  uploadSection.classList.remove('hidden')
}

// Tile Rendering
function renderTiles() {
  tilesGrid.innerHTML = ''

  tiles.forEach((text, index) => {
    const tile = createTileElement(text, index)
    tilesGrid.appendChild(tile)
  })
}

function createTileElement(text, index) {
  const tile = document.createElement('div')
  tile.className = 'tile'
  tile.dataset.index = index
  tile.draggable = true

  const textSpan = document.createElement('span')
  textSpan.className = 'tile-text'

  // Add size class based on text length
  if (text.length > 12) {
    textSpan.classList.add('very-long')
  } else if (text.length > 8) {
    textSpan.classList.add('long')
  }

  textSpan.textContent = text
  tile.appendChild(textSpan)

  // Touch events for mobile
  tile.addEventListener('touchstart', handleTouchStart, { passive: false })
  tile.addEventListener('touchmove', handleTouchMove, { passive: false })
  tile.addEventListener('touchend', handleTouchEnd)

  // Mouse events for desktop
  tile.addEventListener('dragstart', handleDragStart)
  tile.addEventListener('dragend', handleDragEnd)
  tile.addEventListener('dragover', handleDragOver)
  tile.addEventListener('dragleave', handleDragLeave)
  tile.addEventListener('drop', handleDrop)

  return tile
}

// Drag and Drop (Desktop)
function handleDragStart(e) {
  draggedTile = e.target.closest('.tile')
  draggedIndex = parseInt(draggedTile.dataset.index)
  draggedTile.classList.add('dragging')

  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', draggedIndex)
}

function handleDragEnd(e) {
  if (draggedTile) {
    draggedTile.classList.remove('dragging')
  }

  document.querySelectorAll('.tile').forEach(tile => {
    tile.classList.remove('drag-over')
  })

  draggedTile = null
  draggedIndex = null
}

function handleDragOver(e) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'

  const tile = e.target.closest('.tile')
  if (tile && tile !== draggedTile) {
    tile.classList.add('drag-over')
  }
}

function handleDragLeave(e) {
  const tile = e.target.closest('.tile')
  if (tile) {
    tile.classList.remove('drag-over')
  }
}

function handleDrop(e) {
  e.preventDefault()

  const targetTile = e.target.closest('.tile')
  if (!targetTile || targetTile === draggedTile) return

  const targetIndex = parseInt(targetTile.dataset.index)
  swapTiles(draggedIndex, targetIndex)
}

// Touch Events (Mobile)
let touchStartX = 0
let touchStartY = 0
let touchCurrentTile = null
let touchClone = null

function handleTouchStart(e) {
  const tile = e.target.closest('.tile')
  if (!tile) return

  touchCurrentTile = tile
  draggedIndex = parseInt(tile.dataset.index)

  const touch = e.touches[0]
  touchStartX = touch.clientX
  touchStartY = touch.clientY

  // Create a visual clone for dragging
  touchClone = tile.cloneNode(true)
  touchClone.classList.add('dragging')
  touchClone.style.position = 'fixed'
  touchClone.style.pointerEvents = 'none'
  touchClone.style.width = tile.offsetWidth + 'px'
  touchClone.style.height = tile.offsetHeight + 'px'
  touchClone.style.zIndex = '1000'

  positionTouchClone(touch.clientX, touch.clientY, tile)
  document.body.appendChild(touchClone)

  tile.style.opacity = '0.3'

  e.preventDefault()
}

function handleTouchMove(e) {
  if (!touchClone || !touchCurrentTile) return

  const touch = e.touches[0]
  positionTouchClone(touch.clientX, touch.clientY, touchCurrentTile)

  // Find tile under touch point
  touchClone.style.display = 'none'
  const elementUnder = document.elementFromPoint(touch.clientX, touch.clientY)
  touchClone.style.display = ''

  // Clear previous drag-over states
  document.querySelectorAll('.tile.drag-over').forEach(t => {
    t.classList.remove('drag-over')
  })

  // Add drag-over to tile under touch
  const tileUnder = elementUnder?.closest('.tile')
  if (tileUnder && tileUnder !== touchCurrentTile) {
    tileUnder.classList.add('drag-over')
  }

  e.preventDefault()
}

function handleTouchEnd(e) {
  if (!touchClone || !touchCurrentTile) return

  // Find final position
  const touch = e.changedTouches[0]
  touchClone.style.display = 'none'
  const elementUnder = document.elementFromPoint(touch.clientX, touch.clientY)
  touchClone.style.display = ''

  const targetTile = elementUnder?.closest('.tile')

  if (targetTile && targetTile !== touchCurrentTile) {
    const targetIndex = parseInt(targetTile.dataset.index)
    swapTiles(draggedIndex, targetIndex)
  }

  // Cleanup
  touchClone.remove()
  touchClone = null
  touchCurrentTile.style.opacity = ''
  touchCurrentTile = null
  draggedIndex = null

  document.querySelectorAll('.tile.drag-over').forEach(t => {
    t.classList.remove('drag-over')
  })
}

function positionTouchClone(x, y, originalTile) {
  if (!touchClone) return

  const width = originalTile.offsetWidth
  const height = originalTile.offsetHeight

  touchClone.style.left = (x - width / 2) + 'px'
  touchClone.style.top = (y - height / 2) + 'px'
}

// Tile Operations
function swapTiles(indexA, indexB) {
  if (indexA === indexB) return
  if (indexA < 0 || indexA >= 16 || indexB < 0 || indexB >= 16) return

  // Swap in array
  const temp = tiles[indexA]
  tiles[indexA] = tiles[indexB]
  tiles[indexB] = temp

  // Save and re-render
  saveState()
  renderTiles()
}

function shuffleTiles() {
  // Fisher-Yates shuffle
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const temp = tiles[i]
    tiles[i] = tiles[j]
    tiles[j] = temp
  }

  saveState()
  renderTiles()
}

