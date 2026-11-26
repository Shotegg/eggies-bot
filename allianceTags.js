function getAllianceTags(primaryTag, configuredTags) {
  const tags = configuredTags || `${primaryTag},EPC,PEN,WWF,EPc`;
  return [...new Set([primaryTag, ...tags.split(',').map((tag) => tag.trim())].filter(Boolean))];
}

function getPrimaryRoster(primaryTag, requestedTags, rosters) {
  return rosters[requestedTags.indexOf(primaryTag)] || null;
}

module.exports = { getAllianceTags, getPrimaryRoster };
