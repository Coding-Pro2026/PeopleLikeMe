'use strict';
// Interest taxonomy. Each tag has:
//   cluster - related tags share a cluster, so "anime" and "manga" get partial credit
//   pop     - prior popularity 0..1 (rarer shared interests are worth more; see engine idf)
//   v       - inferred venue affinities (0..1) used by the Surprise Spot engine
// Tags in the `places` group are what people *explicitly* say they like going to; the
// Surprise Spot engine deliberately avoids venue types either person picked there.

const G = (id, label, emoji, tags) => ({ id, label, emoji, tags });
const T = (id, label, emoji, cluster, pop, v = {}) => ({ id, label, emoji, cluster, pop, v });

const GROUPS = [
  G('movies', 'Movies & shows', '🎬', [
    T('movies:scifi', 'Sci-fi', '🚀', 'speculative', 0.55, { cinema: 0.8, arcade: 0.4, comics: 0.5 }),
    T('movies:fantasy', 'Fantasy', '🐉', 'speculative', 0.5, { cinema: 0.6, bookstore: 0.5, boardgame: 0.5 }),
    T('movies:horror', 'Horror', '👻', 'dark', 0.35, { cinema: 0.8 }),
    T('movies:thriller', 'Thrillers & mystery', '🕵️', 'dark', 0.45, { cinema: 0.7, bookstore: 0.3 }),
    T('movies:comedy', 'Comedy', '😂', 'light', 0.7, { cinema: 0.6, icecream: 0.3 }),
    T('movies:romcom', 'Rom-coms', '💞', 'light', 0.4, { cinema: 0.6, cafe: 0.4, bakery: 0.3 }),
    T('movies:animation', 'Animation & Ghibli', '🌸', 'anime', 0.45, { cinema: 0.5, garden: 0.4, tea: 0.4 }),
    T('movies:anime', 'Anime', '🍥', 'anime', 0.45, { comics: 0.7, arcade: 0.5, restaurant: 0.3 }),
    T('movies:documentary', 'Documentaries', '🎥', 'real', 0.3, { museum: 0.7, library: 0.4 }),
    T('movies:drama', 'Drama', '🎭', 'real', 0.5, { cinema: 0.6, gallery: 0.4 }),
    T('movies:classic', 'Classic cinema', '🎞️', 'real', 0.2, { cinema: 0.8, museum: 0.4 }),
    T('movies:kdrama', 'K-dramas', '🇰🇷', 'light', 0.3, { restaurant: 0.5, cafe: 0.5 }),
    T('movies:superhero', 'Superheroes', '🦸', 'speculative', 0.45, { cinema: 0.7, comics: 0.8 }),
    T('movies:truecrime', 'True crime', '🔎', 'dark', 0.3, { library: 0.3, cafe: 0.4 }),
  ]),
  G('music', 'Music', '🎧', [
    T('music:indie', 'Indie', '🎸', 'alt', 0.45, { records: 0.8, cafe: 0.5 }),
    T('music:rock', 'Rock & metal', '🤘', 'alt', 0.45, { records: 0.8 }),
    T('music:pop', 'Pop', '🎤', 'mainstream', 0.65, { icecream: 0.3, market: 0.3 }),
    T('music:hiphop', 'Hip-hop', '🎙️', 'mainstream', 0.5, { records: 0.6, market: 0.3 }),
    T('music:lofi', 'Lo-fi & chill', '🌙', 'calm', 0.45, { cafe: 0.7, library: 0.5, tea: 0.5 }),
    T('music:classical', 'Classical & jazz', '🎻', 'calm', 0.25, { gallery: 0.5, museum: 0.4, tea: 0.4, records: 0.4 }),
    T('music:edm', 'Electronic', '🎛️', 'alt', 0.35, { records: 0.6, arcade: 0.3 }),
    T('music:kpop', 'K-pop', '💫', 'mainstream', 0.3, { records: 0.5, restaurant: 0.4 }),
    T('music:folk', 'Folk & acoustic', '🪕', 'calm', 0.25, { cafe: 0.5, park: 0.5, market: 0.4 }),
    T('music:ost', 'Game & film soundtracks', '🎼', 'speculative', 0.3, { arcade: 0.5, records: 0.5 }),
  ]),
  G('food', 'Food & drink', '🍜', [
    T('food:ramen', 'Ramen & noodles', '🍜', 'asian', 0.5, { restaurant: 0.9 }),
    T('food:sushi', 'Sushi', '🍣', 'asian', 0.45, { restaurant: 0.8 }),
    T('food:pizza', 'Pizza', '🍕', 'comfort', 0.7, { restaurant: 0.7 }),
    T('food:burgers', 'Burgers', '🍔', 'comfort', 0.55, { restaurant: 0.7 }),
    T('food:tacos', 'Tacos & street food', '🌮', 'street', 0.5, { market: 0.8, restaurant: 0.5 }),
    T('food:coffee', 'Coffee', '☕', 'cafe', 0.7, { cafe: 0.95, bakery: 0.4 }),
    T('food:tea', 'Tea', '🍵', 'cafe', 0.4, { tea: 0.9, cafe: 0.5, garden: 0.3 }),
    T('food:baking', 'Baking & pastries', '🧁', 'sweet', 0.45, { bakery: 0.95, cafe: 0.5 }),
    T('food:desserts', 'Desserts & ice cream', '🍦', 'sweet', 0.6, { icecream: 0.95, bakery: 0.6 }),
    T('food:spicy', 'Spicy food', '🌶️', 'asian', 0.4, { restaurant: 0.7, market: 0.5 }),
    T('food:vegan', 'Vegetarian / vegan', '🥗', 'fresh', 0.3, { market: 0.7, restaurant: 0.5, cafe: 0.4 }),
    T('food:cooking', 'Cooking at home', '🍳', 'fresh', 0.5, { market: 0.8, bakery: 0.3 }),
    T('food:bbq', 'BBQ & grilling', '🍖', 'comfort', 0.35, { park: 0.6, restaurant: 0.5 }),
    T('food:boba', 'Boba', '🧋', 'street', 0.35, { tea: 0.7, cafe: 0.5 }),
  ]),
  G('hobbies', 'Hobbies', '🎯', [
    T('hobby:reading', 'Reading', '📖', 'mind', 0.65, { bookstore: 0.9, library: 0.9, cafe: 0.5 }),
    T('hobby:gaming', 'Video games', '🎮', 'play', 0.7, { arcade: 0.9, comics: 0.4, boardgame: 0.4 }),
    T('hobby:boardgames', 'Board & card games', '🎲', 'play', 0.4, { boardgame: 0.95, cafe: 0.5 }),
    T('hobby:drawing', 'Drawing & art', '🖌️', 'make', 0.45, { gallery: 0.8, museum: 0.6, park: 0.4 }),
    T('hobby:writing', 'Writing', '✍️', 'make', 0.35, { library: 0.7, bookstore: 0.6, cafe: 0.7 }),
    T('hobby:photography', 'Photography', '📷', 'make', 0.4, { park: 0.6, gallery: 0.6, waterfront: 0.6, market: 0.5 }),
    T('hobby:coding', 'Coding & tech', '💻', 'mind', 0.45, { cafe: 0.6, library: 0.5, arcade: 0.3 }),
    T('hobby:crafts', 'Crafts & DIY', '🧶', 'make', 0.35, { market: 0.7, comics: 0.5 }),
    T('hobby:gardening', 'Plants & gardening', '🪴', 'nature', 0.4, { garden: 0.95, market: 0.6, park: 0.5 }),
    T('hobby:hiking', 'Hiking & walking', '🥾', 'nature', 0.5, { trail: 0.95, park: 0.7, waterfront: 0.5 }),
    T('hobby:fitness', 'Gym & fitness', '🏋️', 'active', 0.5, { climbing: 0.6, park: 0.5, trail: 0.4 }),
    T('hobby:yoga', 'Yoga & mindfulness', '🧘', 'calm', 0.35, { garden: 0.6, park: 0.6, tea: 0.4 }),
    T('hobby:cycling', 'Cycling', '🚴', 'active', 0.3, { trail: 0.7, waterfront: 0.6, park: 0.5 }),
    T('hobby:climbing', 'Climbing & bouldering', '🧗', 'active', 0.2, { climbing: 0.95, trail: 0.4 }),
    T('hobby:cats', 'Cats', '🐱', 'animals', 0.5, { cafe: 0.3, park: 0.3 }),
    T('hobby:dogs', 'Dogs', '🐶', 'animals', 0.55, { park: 0.8, trail: 0.5 }),
    T('hobby:space', 'Space & science', '🔭', 'mind', 0.35, { museum: 0.8, library: 0.4, zoo: 0.3 }),
    T('hobby:history', 'History', '🏺', 'mind', 0.35, { museum: 0.9, library: 0.5, bookstore: 0.4 }),
    T('hobby:thrifting', 'Thrifting & vintage', '🧥', 'make', 0.3, { market: 0.8, records: 0.5, bookstore: 0.4 }),
    T('hobby:travel', 'Travel', '🧳', 'active', 0.6, { market: 0.5, waterfront: 0.4, museum: 0.4 }),
  ]),
  G('books', 'Books & stories', '📚', [
    T('books:fantasy', 'Fantasy novels', '🧙', 'speculative', 0.5, { bookstore: 0.9, library: 0.6, boardgame: 0.4 }),
    T('books:scifi', 'Sci-fi novels', '🛸', 'speculative', 0.4, { bookstore: 0.8, library: 0.6, comics: 0.4 }),
    T('books:manga', 'Manga & comics', '📕', 'anime', 0.45, { comics: 0.95, bookstore: 0.5 }),
    T('books:selfhelp', 'Self-growth', '🌱', 'mind', 0.4, { bookstore: 0.6, library: 0.5, cafe: 0.4 }),
    T('books:romance', 'Romance novels', '💌', 'light', 0.4, { bookstore: 0.7, cafe: 0.5 }),
    T('books:classics', 'Classics & literature', '🪶', 'real', 0.25, { library: 0.8, bookstore: 0.8 }),
    T('books:nonfiction', 'Non-fiction', '📰', 'real', 0.35, { library: 0.7, bookstore: 0.6, museum: 0.4 }),
    T('books:poetry', 'Poetry', '🌙', 'calm', 0.2, { bookstore: 0.8, cafe: 0.6, garden: 0.4 }),
  ]),
  // What people *say* they like doing/going. The Surprise Spot avoids these on purpose.
  G('places', 'Places I like to go', '📍', [
    T('place:cafe', 'Cafés', '☕', 'p', 0.7, { cafe: 1 }),
    T('place:bookstore', 'Bookstores', '📚', 'p', 0.45, { bookstore: 1 }),
    T('place:library', 'Libraries', '🏛️', 'p', 0.4, { library: 1 }),
    T('place:park', 'Parks', '🌳', 'p', 0.6, { park: 1 }),
    T('place:garden', 'Gardens', '🌷', 'p', 0.35, { garden: 1 }),
    T('place:museum', 'Museums', '🖼️', 'p', 0.4, { museum: 1 }),
    T('place:gallery', 'Art galleries', '🎨', 'p', 0.3, { gallery: 1 }),
    T('place:cinema', 'Cinemas', '🍿', 'p', 0.55, { cinema: 1 }),
    T('place:arcade', 'Arcades', '🕹️', 'p', 0.3, { arcade: 1 }),
    T('place:boardgame', 'Board-game spots', '🎲', 'p', 0.25, { boardgame: 1 }),
    T('place:comics', 'Comic / hobby shops', '🦸', 'p', 0.25, { comics: 1 }),
    T('place:records', 'Record stores', '💿', 'p', 0.2, { records: 1 }),
    T('place:bakery', 'Bakeries', '🥐', 'p', 0.4, { bakery: 1 }),
    T('place:icecream', 'Ice-cream shops', '🍦', 'p', 0.4, { icecream: 1 }),
    T('place:restaurant', 'Restaurants', '🍽️', 'p', 0.6, { restaurant: 1 }),
    T('place:tea', 'Tea houses', '🍵', 'p', 0.25, { tea: 1 }),
    T('place:trail', 'Trails & nature walks', '🥾', 'p', 0.4, { trail: 1 }),
    T('place:waterfront', 'Beaches & waterfronts', '🌊', 'p', 0.45, { waterfront: 1 }),
    T('place:bowling', 'Bowling / mini-golf', '🎳', 'p', 0.25, { bowling: 1 }),
    T('place:zoo', 'Zoos & aquariums', '🐠', 'p', 0.3, { zoo: 1 }),
    T('place:market', 'Markets', '🧺', 'p', 0.35, { market: 1 }),
    T('place:climbing', 'Climbing gyms', '🧗', 'p', 0.15, { climbing: 1 }),
  ]),
];

// What free-text "favourites" a person may add (max 3 each, 40 chars).
const FAV_CATEGORIES = [
  { id: 'movie', label: 'Favourite movie or show', placeholder: 'e.g. Spirited Away' },
  { id: 'food', label: 'Favourite food', placeholder: 'e.g. tonkotsu ramen' },
  { id: 'place', label: 'A place you love', placeholder: 'e.g. the riverside path' },
  { id: 'music', label: 'Favourite artist or album', placeholder: 'e.g. Phoebe Bridgers' },
  { id: 'book', label: 'Favourite book or game', placeholder: 'e.g. Stardew Valley' },
];

const TAGS = Object.fromEntries(GROUPS.flatMap((g) => g.tags.map((t) => [t.id, { ...t, group: g.id }])));

module.exports = { GROUPS, TAGS, FAV_CATEGORIES };
