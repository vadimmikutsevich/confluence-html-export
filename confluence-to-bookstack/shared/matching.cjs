// Normalize lookup keys only; preserve the original titles, URLs and content.
function normalizeLookupKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

module.exports = { normalizeLookupKey };
