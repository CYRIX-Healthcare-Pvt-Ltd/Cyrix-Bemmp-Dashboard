/**
 * Uttar Pradesh's zone and division for every district — from MASTER FILES/Zone & Division.xlsx,
 * sheet UP (the user, 23 Sep). The TM export carries both on each call; this is what fills them
 * when a call comes without them (`deriveUp` in schema.mjs).
 *
 * Matched loosely — case, spaces and punctuation ignored — because the export and the master
 * do not always spell a district alike. Where they differ in more than that, ALIASES says which
 * is which: the export's Balarampur, Raebareli and Sant Ravidas Nagar are the master's
 * Balrampur, Rai Bareli and Bhadohi -St Sant Ravidas.
 */

/** [district, zone, division], as the master writes them. */
export const UP_AREAS = [
  ["Agra", "Zone1", "Agra"],
  ["Aligarh", "Zone1", "Aligarh"],
  ["Ambedkar Nagar", "Zone2", "Ayodhya"],
  ["Amethi", "Zone2", "Ayodhya"],
  ["Amroha", "Zone1", "Moradabad"],
  ["Auraiya", "Zone3", "Kanpur"],
  ["Ayodhya", "Zone2", "Ayodhya"],
  ["Azamgarh", "Zone4", "Azamgarh"],
  ["Baghpat", "Zone1", "Meerut"],
  ["Bahraich", "Zone2", "Gonda"],
  ["Ballia", "Zone4", "Azamgarh"],
  ["Balrampur", "Zone2", "Gonda"],
  ["Banda", "Zone3", "Chitrakoot"],
  ["Barabanki", "Zone2", "Ayodhya"],
  ["Bareilly", "Zone2", "Bareilly"],
  ["Basti", "Zone4", "Basti"],
  ["Bhadohi -St Sant Ravidas", "Zone4", "Varanasi"],
  ["Bijnor", "Zone1", "Moradabad"],
  ["Budaun", "Zone2", "Bareilly"],
  ["Bulandshahar", "Zone1", "Meerut"],
  ["Chandauli", "Zone4", "Mirzapur"],
  ["Chitrakoot", "Zone3", "Chitrakoot"],
  ["Deoria", "Zone4", "Gorakhpur"],
  ["Etah", "Zone1", "Aligarh"],
  ["Etawah", "Zone3", "Kanpur"],
  ["Farrukhabad", "Zone3", "Kanpur"],
  ["Fatehpur", "Zone3", "Prayagraj"],
  ["Firozabad", "Zone1", "Agra"],
  ["Gautam Budh Nagar", "Zone1", "Meerut"],
  ["Ghaziabad", "Zone1", "Meerut"],
  ["Ghazipur", "Zone4", "Varanasi"],
  ["Gonda", "Zone2", "Gonda"],
  ["Gorakhpur", "Zone4", "Gorakhpur"],
  ["Hamirpur", "Zone3", "Chitrakoot"],
  ["Hapur", "Zone1", "Meerut"],
  ["Hardoi", "Zone2", "Lucknow"],
  ["Hathras", "Zone1", "Aligarh"],
  ["Jalaun", "Zone3", "Jhansi"],
  ["Jaunpur", "Zone4", "Varanasi"],
  ["Jhansi", "Zone3", "Jhansi"],
  ["Kannauj", "Zone3", "Kanpur"],
  ["Kanpur Dehat", "Zone3", "Kanpur"],
  ["Kanpur Nagar", "Zone3", "Kanpur"],
  ["Kasganj", "Zone1", "Aligarh"],
  ["Kaushambi", "Zone3", "Prayagraj"],
  ["Kushinagar", "Zone4", "Gorakhpur"],
  ["Lakhimpur Kheri", "Zone2", "Lucknow"],
  ["Lalitpur", "Zone3", "Jhansi"],
  ["Lucknow", "Zone2", "Lucknow"],
  ["Maharajganj", "Zone4", "Gorakhpur"],
  ["Mahoba", "Zone3", "Chitrakoot"],
  ["Mainpuri", "Zone1", "Agra"],
  ["Mathura", "Zone1", "Agra"],
  ["Mau", "Zone4", "Azamgarh"],
  ["Meerut", "Zone1", "Meerut"],
  ["Mirzapur", "Zone4", "Mirzapur"],
  ["Moradabad", "Zone1", "Moradabad"],
  ["Muzaffarnagar", "Zone1", "Saharanpur"],
  ["Pilibhit", "Zone2", "Bareilly"],
  ["Pratapgarh", "Zone3", "Prayagraj"],
  ["Prayagraj", "Zone3", "Prayagraj"],
  ["Rai Bareli", "Zone2", "Lucknow"],
  ["Rampur", "Zone1", "Moradabad"],
  ["Saharanpur", "Zone1", "Saharanpur"],
  ["Sambhal", "Zone1", "Moradabad"],
  ["Sant Kabir Nagar", "Zone4", "Basti"],
  ["Shahjahanpur", "Zone2", "Bareilly"],
  ["Shamli", "Zone1", "Saharanpur"],
  ["Shravasti", "Zone2", "Gonda"],
  ["Siddharth Nagar", "Zone4", "Basti"],
  ["Sitapur", "Zone2", "Lucknow"],
  ["Sonbhadra", "Zone4", "Mirzapur"],
  ["Sultanpur", "Zone2", "Ayodhya"],
  ["Unnao", "Zone2", "Lucknow"],
  ["Varanasi", "Zone4", "Varanasi"],
];

const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z]/g, '');

/** The export's spelling → the master's, both as keys. */
const ALIASES = {
  balarampur: 'balrampur',
  raebareli: 'raibareli',
  santravidasnagar: 'bhadohistsantravidas',
  bhadohi: 'bhadohistsantravidas',
};

const BY_DISTRICT = new Map(UP_AREAS.map(([district, zone, division]) => [key(district), { zone, division }]));

/** A district's zone and division, or null when the master has no such district. */
export function upAreaOf(district) {
  const k = key(district);
  return BY_DISTRICT.get(ALIASES[k] ?? k) ?? null;
}
