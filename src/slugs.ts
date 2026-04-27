// Adjective + animal + 2-digit number. Space ~64*64*100 = ~410k. Plenty.
export const ADJECTIVES = [
  "amber","azure","brave","brisk","calm","clever","crisp","damp","dapper","deep",
  "eager","early","easy","empty","fair","fancy","fierce","first","flat","fond",
  "frail","frosty","fuzzy","gentle","glad","glassy","golden","grand","gritty","happy",
  "hasty","honest","humble","icy","jolly","kind","late","lively","lone","loud",
  "lucky","mellow","merry","misty","muddy","noble","odd","old","pale","plain",
  "polite","proud","quick","quiet","rapid","raw","ready","rich","ripe","rough",
  "rusty","sage","salty","sandy","sharp","shiny","short","silent","silly","silver",
  "slim","slow","small","smooth","snowy","sober","soft","solid","sour","spry",
  "stark","steep","stern","still","stout","strong","sturdy","sunny","swift","tall",
  "tame","tart","teal","tense","thin","tidy","tiny","tough","vivid","warm",
  "weary","wide","wild","wise","witty","zany"
];

export const ANIMALS = [
  "ant","ape","badger","bat","bear","beaver","bee","bison","boar","camel",
  "cat","cobra","cow","crab","crane","crow","deer","dog","dove","duck",
  "eagle","eel","elk","emu","falcon","ferret","finch","fish","fox","frog",
  "gecko","goat","goose","gull","hare","hawk","hen","heron","horse","hound",
  "ibex","ibis","jay","koala","lamb","lark","lemur","lion","llama","lynx",
  "magpie","mole","moose","moth","mouse","mule","newt","ocelot","orca","otter",
  "owl","ox","panda","perch","pig","pony","puma","quail","rabbit","ram",
  "rat","raven","robin","seal","shark","sheep","shrew","skunk","sloth","snail",
  "snake","sparrow","spider","squid","stag","stoat","stork","swan","tapir","tiger",
  "toad","trout","turkey","viper","vole","walrus","wasp","weasel","whale","wolf",
  "wombat","yak","zebra"
];

export function randomSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const ani = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const num = String(Math.floor(Math.random() * 100)).padStart(2, "0");
  return `${adj}-${ani}-${num}`;
}

export const SLUG_RE = /^[a-z]+-[a-z]+-\d{2}$/;
