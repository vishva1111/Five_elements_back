/**
 * treeImport.js — parse and validate a spreadsheet of tree records.
 *
 * A partner filing work at a desk usually has it in a spreadsheet already, so
 * this accepts .xlsx and .csv and turns them into the same shape the single-tree
 * endpoint writes.
 *
 * Two rules shape the design:
 *   • Headers are matched loosely (case, spaces and common aliases), because the
 *     file comes from a person, not an API.
 *   • Nothing is written unless every row is valid. A half-imported file leaves
 *     the partner unsure what landed, and evidence has to be trustworthy.
 */
const { readSheet, normaliseHeader, matchEnum } = require('./sheetReader')

// Cap the work a single upload can cause.
const MAX_ROWS = 2000

/**
 * Accepted header spellings per field. Compared after lower-casing and
 * stripping everything that isn't a letter or digit, so "Tree Species",
 * "tree_species" and "TreeSpecies" all land on the same field.
 */
const COLUMN_ALIASES = {
  species:         ['species', 'treespecies', 'commonname', 'name'],
  scientific_name: ['scientificname', 'botanicalname', 'latinname'],
  latitude:        ['latitude', 'lat'],
  longitude:       ['longitude', 'lng', 'long', 'lon'],
  quantity:        ['quantity', 'qty', 'count', 'numberoftrees', 'trees'],
  event_type:      ['eventtype', 'event', 'activity'],
  health_status:   ['healthstatus', 'health'],
  tree_condition:  ['condition', 'treecondition'],
  land_type:       ['landtype', 'land'],
  dbh_cm:          ['dbhcm', 'dbh', 'diameter', 'diametercm'],
  height_m:        ['heightm', 'height'],
  notes:           ['notes', 'note', 'remarks', 'comment', 'comments'],
}

const EVENT_TYPES = ['Planting', 'Restoration', 'Measurement', 'Survey', 'Maintenance']
const HEALTH      = ['healthy', 'moderate', 'poor']
const CONDITIONS  = ['Healthy', 'Diseased', 'Damaged', 'Dead']

/**
 * Parse a spreadsheet into validated tree rows.
 *
 * Returns { columns, rows, errors, totalRows }. `rows` holds only the rows that
 * passed; the caller decides whether to write anything when `errors` is non-empty.
 */
async function parseTreeSheet(buffer, filename) {
  const raw = await readSheet(buffer, filename)

  if (raw.length === 0) throw new Error('That file is empty.')
  if (raw.length - 1 > MAX_ROWS) {
    throw new Error(`That file has more than ${MAX_ROWS} rows. Split it into smaller files.`)
  }

  // ── header row ───────────────────────────────────────────────────────────
  const headerCells = raw[0].map(normaliseHeader)
  const columnIndex = {}
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = headerCells.findIndex(h => aliases.includes(h))
    if (idx !== -1) columnIndex[field] = idx
  }

  const missing = ['species', 'latitude', 'longitude'].filter(f => columnIndex[f] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `The first row must name the columns. Missing: ${missing.join(', ')}. ` +
      `Expected headers like: Species, Latitude, Longitude, Quantity, Event Type, Notes.`
    )
  }

  const get = (cells, field) =>
    columnIndex[field] === undefined ? '' : String(cells[columnIndex[field]] ?? '').trim()

  const rows = []
  const errors = []
  let totalRows = 0

  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i]
    // Spreadsheets are full of trailing blank rows; skip them silently.
    if (cells.every(c => String(c ?? '').trim() === '')) continue

    totalRows++
    const lineNo = i + 1          // 1-based, as the person sees it in Excel
    const rowErrors = []

    const species = get(cells, 'species')
    if (!species) rowErrors.push('species is required')

    const latRaw = get(cells, 'latitude')
    const lngRaw = get(cells, 'longitude')
    const latitude  = Number(latRaw)
    const longitude = Number(lngRaw)

    if (!latRaw) rowErrors.push('latitude is required')
    else if (!Number.isFinite(latitude)) rowErrors.push(`latitude "${latRaw}" is not a number`)
    else if (latitude < -90 || latitude > 90) rowErrors.push(`latitude ${latitude} is out of range`)

    if (!lngRaw) rowErrors.push('longitude is required')
    else if (!Number.isFinite(longitude)) rowErrors.push(`longitude "${lngRaw}" is not a number`)
    else if (longitude < -180 || longitude > 180) rowErrors.push(`longitude ${longitude} is out of range`)

    const qtyRaw = get(cells, 'quantity')
    let quantity = 1
    if (qtyRaw) {
      quantity = Number(qtyRaw)
      if (!Number.isFinite(quantity) || quantity < 1) {
        rowErrors.push(`quantity "${qtyRaw}" must be a whole number of 1 or more`)
      } else {
        quantity = Math.floor(quantity)
      }
    }

    // Unknown values in these are corrected rather than rejected — a typo in a
    // descriptive field shouldn't block a whole import.
    const eventType = matchEnum(get(cells, 'event_type'), EVENT_TYPES) || 'Planting'
    const health    = matchEnum(get(cells, 'health_status'), HEALTH) || 'healthy'
    const condition = matchEnum(get(cells, 'tree_condition'), CONDITIONS) || null

    const numOrNull = (v) => {
      const n = Number(v)
      return v && Number.isFinite(n) && n > 0 ? n : null
    }

    if (rowErrors.length > 0) {
      errors.push({ line: lineNo, errors: rowErrors })
      continue
    }

    rows.push({
      line: lineNo,
      species,
      scientific_name: get(cells, 'scientific_name') || null,
      latitude,
      longitude,
      quantity,
      event_type:     eventType,
      health_status:  health,
      tree_condition: condition,
      land_type:      get(cells, 'land_type') || null,
      dbh_cm:         numOrNull(get(cells, 'dbh_cm')),
      height_m:       numOrNull(get(cells, 'height_m')),
      notes:          get(cells, 'notes') || null,
    })
  }

  return {
    columns: Object.keys(columnIndex),
    rows,
    errors,
    totalRows,
  }
}

/** The header row and one example, for the downloadable template. */
function templateCsv() {
  return [
    'Species,Scientific Name,Latitude,Longitude,Quantity,Event Type,Health,Condition,Land Type,DBH (cm),Height (m),Notes',
    'Neem,Azadirachta indica,23.022500,72.571400,1,Planting,healthy,Healthy,Roadside,12.5,4.2,Planted near the school wall',
    'Peepal,Ficus religiosa,23.024100,72.573900,3,Planting,healthy,Healthy,Community land,,,',
  ].join('\n')
}

module.exports = { parseTreeSheet, templateCsv, MAX_ROWS, EVENT_TYPES, HEALTH, CONDITIONS }
