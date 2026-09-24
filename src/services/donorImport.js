/**
 * donorImport.js — parse and validate a spreadsheet of past donations.
 *
 * For paper receipts already collected offline (cash, UPI, bank transfer,
 * cheque) that a partner wants on the record — as distinct from a tree
 * capture, this represents money given, not work done. See tree_records vs
 * individual_fundings: this writes the latter.
 *
 * Same two rules as treeImport.js: headers are matched loosely, and nothing
 * is written unless every row is valid.
 */
const { readSheet, normaliseHeader, matchEnum, parseFlexibleDate } = require('./sheetReader')

const MAX_ROWS = 2000

const COLUMN_ALIASES = {
  donor_name:   ['donorname', 'name', 'funder', 'funders', 'donor', 'donatedby'],
  email:        ['email', 'emailaddress', 'emailid'],
  trees:        ['treesfunded', 'trees', 'quantity', 'treecount', 'numberoftrees'],
  amount:       ['amountpaid', 'amount', 'rs', 'rupees', 'donationamount', 'amt'],
  date:         ['date', 'fundedat', 'receiptdate', 'donationdate'],
  anonymous:    ['anonymous', 'hideidentity', 'public'],
  account_type: ['accounttype', 'type', 'role', 'donortype'],
}

const ACCOUNT_TYPES = ['business', 'individual']
const TRUTHY = ['yes', 'y', 'true', '1']
const FALSY  = ['no', 'n', 'false', '0', '']

/**
 * Parse a spreadsheet of donations. `project` supplies price_per_tree so a
 * row that omits an amount can preview the amount it will actually be
 * written with.
 *
 * Returns { columns, rows, errors, totalRows }. `rows` holds only rows that
 * passed; the caller decides whether to write anything when `errors` is
 * non-empty.
 */
async function parseDonorSheet(buffer, filename, project) {
  const raw = await readSheet(buffer, filename)

  if (raw.length === 0) throw new Error('That file is empty.')
  if (raw.length - 1 > MAX_ROWS) {
    throw new Error(`That file has more than ${MAX_ROWS} rows. Split it into smaller files.`)
  }

  const headerCells = raw[0].map(normaliseHeader)
  const columnIndex = {}
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const idx = headerCells.findIndex(h => aliases.includes(h))
    if (idx !== -1) columnIndex[field] = idx
  }

  const missing = ['donor_name', 'trees'].filter(f => columnIndex[f] === undefined)
  if (missing.length > 0) {
    throw new Error(
      `The first row must name the columns. Missing: ${missing.join(', ')}. ` +
      `Expected headers like: Donor Name, Trees Funded, Amount Paid, Date, Email, Anonymous.`
    )
  }

  const get = (cells, field) =>
    columnIndex[field] === undefined ? '' : String(cells[columnIndex[field]] ?? '').trim()

  const pricePerTree = Number(project?.price_per_tree) > 0 ? Number(project.price_per_tree) : 100

  const rows = []
  const errors = []
  let totalRows = 0

  for (let i = 1; i < raw.length; i++) {
    const cells = raw[i]
    if (cells.every(c => String(c ?? '').trim() === '')) continue

    totalRows++
    const lineNo = i + 1
    const rowErrors = []

    const donorName = get(cells, 'donor_name')
    if (!donorName) rowErrors.push('donor name is required')

    const treesRaw = get(cells, 'trees')
    let trees = null
    if (!treesRaw) {
      rowErrors.push('trees funded is required')
    } else {
      trees = Number(treesRaw)
      if (!Number.isFinite(trees) || trees < 1) {
        rowErrors.push(`"${treesRaw}" is not a valid tree count`)
      } else {
        trees = Math.floor(trees)
      }
    }

    const amountRaw = get(cells, 'amount')
    let amount = null
    if (amountRaw) {
      amount = Number(amountRaw)
      if (!Number.isFinite(amount) || amount < 0) {
        rowErrors.push(`amount "${amountRaw}" is not a valid number`)
        amount = null
      }
    }

    const email = get(cells, 'email')
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      rowErrors.push(`"${email}" doesn't look like a valid email`)
    }

    const accountTypeRaw = get(cells, 'account_type')
    let accountType = 'individual'
    if (accountTypeRaw) {
      const matched = matchEnum(accountTypeRaw, ACCOUNT_TYPES)
      if (!matched) rowErrors.push(`account type "${accountTypeRaw}" must be Business or Individual`)
      else accountType = matched
    }

    const dateRaw = get(cells, 'date')
    let date = null
    if (dateRaw) {
      date = parseFlexibleDate(dateRaw)
      if (!date) rowErrors.push(`date "${dateRaw}" could not be understood — use DD-MM-YYYY`)
    }

    const anonRaw = get(cells, 'anonymous').toLowerCase()
    let anonymous = false
    if (anonRaw && TRUTHY.includes(anonRaw)) anonymous = true
    else if (anonRaw && !FALSY.includes(anonRaw)) {
      rowErrors.push(`"anonymous" value "${anonRaw}" should be Yes or No`)
    }

    if (rowErrors.length > 0) {
      errors.push({ line: lineNo, errors: rowErrors })
      continue
    }

    rows.push({
      line: lineNo,
      donor_name:   donorName,
      email:        email || null,
      trees,
      // The preview shows what will actually be written even when the sheet
      // left amount blank — the write path applies this same fallback.
      amount:       amount ?? Math.round(trees * pricePerTree),
      amountGiven:  amount !== null,
      date,
      anonymous,
      account_type: accountType,
    })
  }

  return { columns: Object.keys(columnIndex), rows, errors, totalRows }
}

/** The header row and one example, for the downloadable template. */
function templateCsv() {
  return [
    'Donor Name,Email,Trees Funded,Amount Paid,Date,Anonymous,Account Type',
    'Dobariya & Co. Insurance,,2,3000,07-09-2026,No,Business',
    'Ramesh Patel,ramesh@example.com,5,,15-09-2026,No,Individual',
  ].join('\n')
}

module.exports = { parseDonorSheet, templateCsv, MAX_ROWS, ACCOUNT_TYPES }
