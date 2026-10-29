// Edit only the text values in this file to change the weekly report's wording.
const REPORT_TEMPLATES = Object.freeze({
  normal: {
    title: '🏰 **EGG Weekly Power Report**',
    biggestGain: '📈 **Biggest power gain**',
    bestPercentage: '📊 **Best percentage gain**',
    smallestGain: '🌱 **Smallest positive power gain**',
    smallestPercentage: '🍃 **Smallest positive percentage gain**',
    losses: '💀 **Fallen power**',
    highGainMessage: 'Save resources for KvK, {name}!',
    lowGainMessage: 'Bravo, {name}! Smart resource saving for KvK.',
    lossMessage: 'Oh! Wow, {name} lost {power}! Taking a step back to make a huge leap during KvK?'
  },
  push: {
    title: '⚔️ **EGG KvK Week Power Report**',
    biggestGain: '📈 **Biggest power gain**',
    bestPercentage: '📊 **Best percentage gain**',
    smallestGain: '🌱 **Smallest positive power gain**',
    smallestPercentage: '🍃 **Smallest positive percentage gain**',
    losses: '⚔️ **Honoring our fallen troops**',
    highGainMessage: 'Bravo, {name}! Your push strengthened EGG!',
    lowGainMessage: 'Push a bit more next time, {name} — EGG believes in you!',
    lossMessage: 'Congratulations to our fighters! {name} lost {power}; their fallen troops served our kingdom to the end.'
  }
});

function applyTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

module.exports = { REPORT_TEMPLATES, applyTemplate };
