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
    const worker = await Tesseract.createWorker('eng')

    showProcessing('Analyzing screenshot...')

    // Configure for better recognition of short uppercase words
    await worker.setParameters({
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -\'&',
    })

    const result = await worker.recognize(imageData)

    showProcessing('Extracting tiles...')

    console.log('OCR raw text:', result.data.text)
    console.log('OCR words found:', result.data.words?.length || 0)

    // Extract words from OCR result
    const extractedTiles = extractTilesFromOCR(result)
    console.log('Extracted tiles:', extractedTiles)

    await worker.terminate()

    if (extractedTiles.length < 16) {
      // If we didn't get enough tiles, try a different approach
      console.log('Only found', extractedTiles.length, 'tiles, attempting fallback extraction')
      const fallbackTiles = extractTilesFallback(result.data.text)

      if (fallbackTiles.length >= 16) {
        tiles = fallbackTiles.slice(0, 16)
      } else if (extractedTiles.length > 0) {
        // Pad with placeholders if needed
        tiles = extractedTiles
        while (tiles.length < 16) {
          tiles.push(`TILE ${tiles.length + 1}`)
        }
      } else {
        throw new Error('Could not extract enough tiles from the image')
      }
    } else {
      tiles = extractedTiles.slice(0, 16)
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

function extractTilesFromOCR(result) {
  const allWords = []

  // Collect all valid words with their positions
  if (result.data.words) {
    for (const word of result.data.words) {
      const text = word.text.trim().toUpperCase()

      if (isValidTileWord(text) && word.confidence > 50) {
        allWords.push({
          text: text,
          confidence: word.confidence,
          bbox: word.bbox,
          centerY: (word.bbox.y0 + word.bbox.y1) / 2,
          centerX: (word.bbox.x0 + word.bbox.x1) / 2
        })
      }
    }
  }

  if (allWords.length === 0) return []

  // Find the grid region by looking for clusters of words
  // The Connections grid is typically 4 rows of 4 words each
  // Sort by Y position to find row clusters
  const sortedByY = [...allWords].sort((a, b) => a.centerY - b.centerY)

  // Find image height from the max Y coordinate
  const maxY = Math.max(...allWords.map(w => w.bbox.y1))
  const minY = Math.min(...allWords.map(w => w.bbox.y0))
  const imageHeight = maxY - minY

  // The grid is usually in the upper-middle portion (roughly 15-75% of content area)
  // Filter to words in this region
  const gridMinY = minY + imageHeight * 0.1
  const gridMaxY = minY + imageHeight * 0.85

  const gridWords = allWords.filter(w =>
    w.centerY >= gridMinY && w.centerY <= gridMaxY
  )

  if (gridWords.length < 16) {
    // If filtering removed too many, use all words
    console.log('Grid filtering too aggressive, using all words')
  }

  const wordsToUse = gridWords.length >= 16 ? gridWords : allWords

  // Cluster words into 4 rows based on Y position
  const rows = clusterIntoRows(wordsToUse, 4)

  // Sort each row by X position (left to right)
  const sortedRows = rows.map(row =>
    row.sort((a, b) => a.centerX - b.centerX)
  )

  // Flatten and take the text, limiting to 4 per row
  const tiles = []
  for (const row of sortedRows) {
    const rowTiles = row.slice(0, 4).map(w => w.text)
    tiles.push(...rowTiles)
  }

  // Remove duplicates while preserving order
  const seen = new Set()
  const uniqueTiles = tiles.filter(text => {
    if (seen.has(text)) return false
    seen.add(text)
    return true
  })

  return uniqueTiles
}

function clusterIntoRows(words, numRows) {
  if (words.length === 0) return Array(numRows).fill([])

  // Sort by Y position
  const sorted = [...words].sort((a, b) => a.centerY - b.centerY)

  // Use k-means-like clustering to find row centers
  const yPositions = sorted.map(w => w.centerY)
  const minY = Math.min(...yPositions)
  const maxY = Math.max(...yPositions)
  const range = maxY - minY

  // Initialize row boundaries evenly
  const rowHeight = range / numRows

  // Assign words to rows based on Y position
  const rows = Array(numRows).fill(null).map(() => [])

  for (const word of sorted) {
    const rowIndex = Math.min(
      numRows - 1,
      Math.floor((word.centerY - minY) / (rowHeight + 0.001))
    )
    rows[rowIndex].push(word)
  }

  // If some rows are empty or have too few words, redistribute
  // This handles cases where clustering didn't work well
  const flatWords = sorted.slice()
  const wordsPerRow = Math.ceil(flatWords.length / numRows)

  // Check if distribution is reasonable (each row should have ~4 words)
  const hasReasonableDistribution = rows.every(r => r.length >= 2 && r.length <= 6)

  if (!hasReasonableDistribution && flatWords.length >= 16) {
    // Fall back to simple division
    const redistributedRows = Array(numRows).fill(null).map(() => [])
    flatWords.forEach((word, i) => {
      const rowIndex = Math.min(numRows - 1, Math.floor(i / 4))
      redistributedRows[rowIndex].push(word)
    })
    return redistributedRows
  }

  return rows
}

function extractTilesFallback(text) {
  console.log('Fallback extraction from raw text:', text)

  // Fallback: split text by lines and filter
  const lines = text.split('\n')
  const words = []

  for (const line of lines) {
    const trimmed = line.trim().toUpperCase()

    // Split line by multiple spaces or single spaces
    const parts = trimmed.split(/\s+/)

    for (const part of parts) {
      const cleaned = part.trim()
      if (isValidTileWord(cleaned)) {
        words.push(cleaned)
      }
    }
  }

  console.log('Fallback found words:', words)

  // Remove duplicates while preserving order
  const seen = new Set()
  return words.filter(word => {
    if (seen.has(word)) return false
    seen.add(word)
    return true
  })
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

