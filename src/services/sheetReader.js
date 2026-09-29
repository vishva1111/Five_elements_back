/**
 * sheetReader.js — shared .xlsx/.csv → rows-of-cells reading.
 *
 * Split out of treeImport.js so donorImport.js (and any future bulk-import
 * feature) don't reimplement the same ExcelJS plumbing.
 */
const ExcelJS = require('exceljs')
const { Readable } = require('stream')

const normaliseHeader = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

/** Cell values arrive as strings, numbers, dates or rich-text objects. */
function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(r => r.text).join('')
    if (value.text !== undefined)   return String(value.text)
    if (value.result !== undefined) return String(value.result)   // formula
    if (value instanceof Date)      return value.toISOString()
    return ''
  }
  return String(value)
}

/** One case-insensitive match from a list, or null. */
function matchEnum(raw, allowed) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return null
  return allowed.find(a => a.toLowerCase() === v) ?? null
}

/** Read the first worksheet of an .xlsx or .csv buffer into rows of cell text. */
async function readSheet(buffer, filename) {
  const isCsv = /\.csv$/i.test(filename || '')
  const workbook = new ExcelJS.Workbook()

  if (isCsv) {
    await workbook.csv.read(Readable.from(buffer))
  } else {
    await workbook.xlsx.load(buffer)
  }

  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('That file has no sheets in it.')

  const rows = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    // row.values is 1-based with a leading hole; drop it.
    const values = Array.isArray(row.values) ? row.values.slice(1) : []
    rows.push(values.map(cellText))
  })
  return rows
}

/**
 * A date cell, or common human-written formats. This app formats dates
 * day-first everywhere (en-GB/en-IN), so an ambiguous "7-9-2026" is read as
 * 7 September, not July 9th — the reverse of the US convention JS's own
 * Date parser assumes.
 */
function parseFlexibleDate(raw) {
  const v = String(raw ?? '').trim()
  if (!v) return null

  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(v)
  if (dmy) {
    const day = Number(dmy[1]), month = Number(dmy[2]), year = Number(dmy[3])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const dt = new Date(Date.UTC(year, month - 1, day))
      if (!Number.isNaN(dt.getTime())) return dt
    }
    return null   // looked date-shaped but wasn't a real date
  }

  // ISO strings (including what cellText() produces for a real Excel date cell)
  const dt = new Date(v)
  return Number.isNaN(dt.getTime()) ? null : dt
}

module.exports = { readSheet, normaliseHeader, cellText, matchEnum, parseFlexibleDate }
