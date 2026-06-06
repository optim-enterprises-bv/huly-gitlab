/**
 * suggestion-parser.js — CSP-safe, no inline scripts, no external deps.
 *
 * Detects suggestion blocks in GitLab note bodies.
 * Supports two forms:
 *   1. GFM fenced code block:  ```suggestion\n...\n```
 *   2. Legacy conflict marker: <<<<<<< SUGGEST\n...\n>>>>>>>> SUGGEST
 *
 * Exported for use by app.js (via window.SuggestionParser) and importable
 * in Node test environments via CommonJS require().
 */

;(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory()
  } else {
    root.SuggestionParser = factory()
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  /**
   * @typedef {Object} SuggestionBlock
   * @property {'gfm'|'legacy'} form
   * @property {string} content  - the suggested replacement lines
   * @property {number} startIndex  - char offset in text where the block starts
   * @property {number} endIndex    - char offset just after the closing marker
   */

  /**
   * Parse all suggestion blocks from a note body string.
   *
   * @param {string} body
   * @returns {SuggestionBlock[]}
   */
  function parseSuggestions (body) {
    if (typeof body !== 'string' || body.length === 0) return []
    const results = []
    parseLegacy(body, results)
    parseGfm(body, results)
    return results
  }

  /**
   * Parse GFM ```suggestion ... ``` blocks.
   * Handles optional range specifiers like ```suggestion:-0+2
   */
  function parseGfm (body, out) {
    // Match opening fence: ```suggestion (optional non-newline chars) then newline
    const openRe = /^```suggestion[^\n]*\n/gm
    let match
    while ((match = openRe.exec(body)) !== null) {
      const openStart = match.index
      const contentStart = openStart + match[0].length
      // Find closing ```
      const closeIdx = body.indexOf('\n```', contentStart)
      if (closeIdx === -1) continue
      const content = body.slice(contentStart, closeIdx)
      const endIndex = closeIdx + 4 // past '\n```'
      out.push({ form: 'gfm', content, startIndex: openStart, endIndex })
      // Advance openRe past this block to avoid partial re-match
      openRe.lastIndex = endIndex
    }
  }

  /**
   * Parse legacy <<<<<<< SUGGEST ... >>>>>>>> SUGGEST blocks.
   */
  function parseLegacy (body, out) {
    const openMarker = '<<<<<<< SUGGEST'
    const closeMarker = '>>>>>>>> SUGGEST'
    let searchFrom = 0
    while (true) {
      const openIdx = body.indexOf(openMarker, searchFrom)
      if (openIdx === -1) break
      const afterOpen = openIdx + openMarker.length
      // skip newline after opening marker
      const contentStart = body[afterOpen] === '\n' ? afterOpen + 1 : afterOpen
      const closeIdx = body.indexOf(closeMarker, contentStart)
      if (closeIdx === -1) break
      // trim trailing newline before close marker
      const contentEnd = body[closeIdx - 1] === '\n' ? closeIdx - 1 : closeIdx
      const content = body.slice(contentStart, contentEnd)
      const endIndex = closeIdx + closeMarker.length
      out.push({ form: 'legacy', content, startIndex: openIdx, endIndex })
      searchFrom = endIndex
    }
  }

  /**
   * Returns true when body contains at least one suggestion block.
   *
   * @param {string} body
   * @returns {boolean}
   */
  function hasSuggestion (body) {
    return parseSuggestions(body).length > 0
  }

  return { parseSuggestions, hasSuggestion }
}))
