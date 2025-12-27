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


async function extractTextFromImage(imageData) {
  showProcessing('Initializing OCR...')

  try {
    // Load the image
    const img = await loadImageElement(imageData)
    console.log('Image dimensions:', img.width, 'x', img.height)

    showProcessing('Processing image...')

    // Crop to grid area
    const startY = Math.floor(img.height * 0.18)
    const endY = Math.floor(img.height * 0.62)
    const startX = Math.floor(img.width * 0.02)
    const endX = Math.floor(img.width * 0.98)
    const w = endX - startX
    const h = endY - startY

    const croppedCanvas = document.createElement('canvas')
    croppedCanvas.width = w
    croppedCanvas.height = h
    const croppedCtx = croppedCanvas.getContext('2d')
    croppedCtx.drawImage(img, startX, startY, w, h, 0, 0, w, h)

    // Apply threshold
    const threshCanvas = document.createElement('canvas')
    threshCanvas.width = w
    threshCanvas.height = h
    const threshCtx = threshCanvas.getContext('2d')
    threshCtx.drawImage(croppedCanvas, 0, 0)

    const imageData2 = threshCtx.getImageData(0, 0, w, h)
    const data = imageData2.data
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2]
      const val = lum > 120 ? 255 : 0
      data[i] = data[i+1] = data[i+2] = val
    }
    threshCtx.putImageData(imageData2, 0, 0)

    let allFoundWords = []

    // Run OCR with PSM modes 3, 6, 11 on full grid
    showProcessing('Running OCR (1/4)...')
    for (const psm of ['3', '6', '11']) {
      const worker = await Tesseract.createWorker('eng')
      await worker.setParameters({ tessedit_pageseg_mode: psm })
      const result = await worker.recognize(threshCanvas)
      await worker.terminate()

      const words = extractWordsFromText(result.data.text)
      for (const word of words.filter(w => isValidTileWord(w))) {
        if (!allFoundWords.includes(word)) allFoundWords.push(word)
      }
      console.log(`PSM ${psm} found:`, words.filter(w => isValidTileWord(w)))
    }

    // Row-by-row with PSM 7
    showProcessing('Running OCR (2/4)...')
    const rowHeight = h / 4
    for (let row = 0; row < 4; row++) {
      const rowCanvas = document.createElement('canvas')
      rowCanvas.width = w
      rowCanvas.height = rowHeight
      const rowCtx = rowCanvas.getContext('2d')
      rowCtx.drawImage(threshCanvas, 0, row * rowHeight, w, rowHeight, 0, 0, w, rowHeight)

      const worker = await Tesseract.createWorker('eng')
      await worker.setParameters({ tessedit_pageseg_mode: '7' })
      const result = await worker.recognize(rowCanvas)
      await worker.terminate()

      const words = extractWordsFromText(result.data.text)
      for (const word of words.filter(w => isValidTileWord(w))) {
        if (!allFoundWords.includes(word)) allFoundWords.push(word)
      }
      console.log(`Row ${row + 1} found:`, words.filter(w => isValidTileWord(w)))
    }

    console.log('All found words:', allFoundWords)

    if (allFoundWords.length >= 16) {
      tiles = allFoundWords.slice(0, 16)
    } else if (allFoundWords.length > 0) {
      tiles = allFoundWords
      while (tiles.length < 16) {
        tiles.push(`TILE ${tiles.length + 1}`)
      }
      console.log(`Only found ${allFoundWords.length} tiles, padded to 16`)
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
  if (!text || text.length < 3) return false  // Tile words are at least 3 chars
  if (text.length > 15) return false

  // Filter out common UI text from Connections app
  const uiWords = [
    'CONNECTIONS', 'CONNECTION', 'CREATE', 'SHUFFLE', 'DESELECT', 'SUBMIT',
    'TODAY', 'ARCHIVE', 'PLAY', 'NYT', 'GAMES', 'MENU', 'GAME',
    'MISTAKES', 'REMAINING', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE',
    'NEXT', 'BACK', 'SHARE', 'RESULTS', 'VIEW', 'ALL',
    'GROUPS', 'GROUP', 'CORRECT', 'INCORRECT', 'GUESS', 'GUESSES',
    'SETTINGS', 'HELP', 'HOW', 'THE', 'AND', 'FOR', 'WITH',
    'YOUR', 'YOU', 'ARE', 'WAS', 'WERE', 'BEEN', 'BEING'
  ]

  if (uiWords.includes(text)) return false

  // Filter out pure numbers
  if (/^\d+$/.test(text)) return false

  // Filter out repeated characters (OCR noise like "EE", "III")
  if (/^(.)\1+$/.test(text)) return false

  // Must have at least one letter
  if (!/[A-Z]/.test(text)) return false

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

