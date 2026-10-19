'use strict';
// Public, low-risk venue types the "Surprise Spot" engine may suggest.
// `osm` is a list of [key, value] pairs used in Overpass queries.
// Only public places are ever suggested (never homes, never private venues).
const VENUES = {
  cafe:        { label: 'a quiet café',            emoji: '☕', osm: [['amenity', 'cafe']] },
  bookstore:   { label: 'a bookstore',             emoji: '📚', osm: [['shop', 'books']] },
  library:     { label: 'a public library',        emoji: '🏛️', osm: [['amenity', 'library']] },
  park:        { label: 'a park',                  emoji: '🌳', osm: [['leisure', 'park']] },
  garden:      { label: 'a garden',                emoji: '🌷', osm: [['leisure', 'garden']] },
  museum:      { label: 'a museum',                emoji: '🖼️', osm: [['tourism', 'museum']] },
  gallery:     { label: 'an art gallery',          emoji: '🎨', osm: [['tourism', 'gallery']] },
  cinema:      { label: 'a cinema',                emoji: '🎬', osm: [['amenity', 'cinema']] },
  arcade:      { label: 'an arcade',               emoji: '🕹️', osm: [['leisure', 'amusement_arcade']] },
  boardgame:   { label: 'a board-game spot',       emoji: '🎲', osm: [['shop', 'games'], ['leisure', 'adult_gaming_centre']] },
  comics:      { label: 'a comic / hobby shop',    emoji: '🦸', osm: [['shop', 'comics'], ['shop', 'hobby']] },
  records:     { label: 'a record store',          emoji: '💿', osm: [['shop', 'music']] },
  bakery:      { label: 'a bakery',                emoji: '🥐', osm: [['shop', 'bakery']] },
  icecream:    { label: 'an ice-cream shop',       emoji: '🍦', osm: [['amenity', 'ice_cream']] },
  restaurant:  { label: 'a casual restaurant',     emoji: '🍜', osm: [['amenity', 'restaurant']] },
  tea:         { label: 'a tea house',             emoji: '🍵', osm: [['shop', 'tea']] },
  trail:       { label: 'a walking spot',          emoji: '🥾', osm: [['leisure', 'nature_reserve'], ['highway', 'footway']] },
  waterfront:  { label: 'a waterfront',            emoji: '🌊', osm: [['natural', 'beach'], ['leisure', 'marina']] },
  bowling:     { label: 'a bowling / mini-golf spot', emoji: '🎳', osm: [['leisure', 'bowling_alley'], ['leisure', 'miniature_golf']] },
  zoo:         { label: 'a zoo or aquarium',       emoji: '🐠', osm: [['tourism', 'zoo'], ['tourism', 'aquarium']] },
  market:      { label: 'a farmers / street market', emoji: '🧺', osm: [['amenity', 'marketplace']] },
  climbing:    { label: 'a climbing gym',          emoji: '🧗', osm: [['sport', 'climbing']] },
};

module.exports = { VENUES };
