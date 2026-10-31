// src/lib/agent/buying-guides.ts
import type { Product } from "@/lib/chat-contract";

/**
 * A Sia Huat salesperson's know-how for one or more catalogue types (round 11): what to ask, what to look for, what goes with it.
 * Drafted 30 Oct from trade knowledge and the products stocked; the client's salespeople correct it. The repo is public: only what
 * Claire may say to a customer, never item codes, prices, sales figures or internal remarks.
 */
export type BuyingGuide = {
  /** Catalogue type names (third_category, or the section for products with none). */
  types: readonly string[];
  /** 1-2 deciding questions, most important first, in a salesperson's trade words. */
  ask: readonly string[];
  /** Answer chips for each ask: 2-3, no numbers. */
  chips: readonly (readonly string[])[];
  /** 'answer: what to look for' lines; attributes, never item codes or prices. */
  fit: readonly string[];
  /** Catalogue types that usually go with it, offered after an add. */
  goes_with?: readonly string[];
  /** What a salesperson checks before recommending (power supply, pack size, oven-safe). */
  watch?: readonly string[];
};

export const BUYING_GUIDES: readonly BuyingGuide[] = [
  {
    types: ["Disposable gloves"],
    ask: ["For food prep, packing, or cleaning?", "Which size?"],
    chips: [["Food prep or raw meat", "Packing or serving", "Cleaning"], ["Small", "Medium", "Large or XL"]],
    fit: [
      "food prep, raw meat, oily food or all-round: nitrile; prefer lower AQL, a stricter quality check",
      "packing or serving: plastic (PE) gloves for fast changes; vinyl for a closer fit",
      "cleaning: nitrile whose data says chemical resistance and wet grip; strong chemicals or dishwashing: rubber gloves (Chemical protection gear)",
      "long gloves or deep tubs: elbow-length, covering forearms",
      "size: PE one size; nitrile, vinyl small to XL",
    ],
    goes_with: ["Disposable hair nets and hygiene caps", "Disposable masks"],
    watch: [
      "check pieces per box and boxes per carton before taking a quantity",
      "food use: prefer ones whose data mentions food; say food-safe only if it does",
    ],
  },
  {
    types: ["European GN pans"],
    ask: ["For hot food, the chiller, or buffet display?", "Full size, half, or smaller?"],
    chips: [["Hot food", "Chiller or cold prep", "Buffet display"], ["Full size", "Half size", "Third or smaller"]],
    fit: [
      "hot food: stainless; perforated to steam or drain; plastic only if rated over 100°C",
      "chiller or cold prep: clear polycarbonate; cheaper: translucent polypropylene",
      "buffet display: stainless for chafers; melamine or porcelain for cold dishes",
      "gravy dishes, soups or storage: solid pan, 100-200mm; chafers or dry dishes: 65mm; baking or display: 20-40mm",
      "heavy use: thicker 18-8 stainless; cheaper: 201 grade",
    ],
    goes_with: ["Serving spoons and forks", "Adaptor bars and holders for GN and steam pans"],
    watch: [
      "lid included or separate; same GN size; notched if a ladle stays in",
      "quote only a listed depth; check it suits their bain marie, chafer or counter",
    ],
  },
  {
    types: ["Wine glasses", "Champagne glasses"],
    ask: ["Fine dining, busy service, or home?", "One all-round glass, separate red and white, or sparkling?"],
    chips: [["Fine dining", "Busy service", "Home or gift"], ["All-round", "Separate red and white", "Sparkling"]],
    fit: [
      "fine dining: crystal or lead-free crystal whose data says so",
      "busy service, banquets or cafes: tempered or shock-resistant glass whose data says so",
      "home or gift: sets",
      "all-round: universal or multi-purpose; separate red and white: same series, bigger bowl for red (Bordeaux, Burgundy)",
      "sparkling: flute, tall and narrow; coupe or saucer, wide and shallow, for a classic look",
    ],
    goes_with: ["Storage and warewashing racks and dollies", "Ice buckets, wine buckets and stands"],
    watch: [
      "check single glass or set before taking a quantity",
      "glasswasher: check tall stems fit the machine and racks; say dishwasher safe only if its data does",
    ],
  },
  {
    types: ["Food storage containers"],
    ask: ["For sauces and prep, meat and veg, or home?", "Single portions, kitchen batches, or bulk?"],
    chips: [["Sauces or prep", "Meat, seafood or veg", "Home or lunch box"], ["Single portions", "Kitchen batches", "Bulk"]],
    fit: [
      "sauces, prep or dry goods: containers with graduations; GN size for GN racks",
      "meat, seafood or veg: wide food storage boxes; shallow to marinate, deep for bulk",
      "home or lunch box: glass or airtight plastic boxes, stainless steel sets or food carriers (tingkat)",
      "single portions: about 300-750ml; soup needs a tight or screw-top lid; kitchen batches: 2-8 litres; bulk: over 8",
    ],
    goes_with: ["Food rotation labels and dispensers"],
    watch: [
      "lid included or separate; if separate, offer the same brand's lid naming that size",
      "hot food or freezer: check its temperature range",
    ],
  },
  {
    types: ["Plates and platters"],
    ask: ["Mains, sides, or sharing platters?", "Porcelain or melamine?"],
    chips: [["Mains", "Sides or dessert", "Sharing platters"], ["Porcelain", "Melamine"]],
    fit: [
      "mains: round, about 23-26cm for rice dishes, 27-31cm for Western; deep plates for pasta",
      "sides or dessert: about 15-20cm",
      "sharing platters: oval, rectangular or large round, about 30cm and up",
      "porcelain: rim plates for classic service; coupe (no wide rim) or reactive glaze for a modern look",
      "melamine: plain white or black for everyday service; wood-grain or bamboo look for casual dining",
    ],
    goes_with: ["Bowls", "Storage and warewashing racks and dollies"],
    watch: [
      "say microwave-, oven- or dishwasher-safe only if its data does; never melamine for microwave or oven",
      "check the series also has the bowls and sizes needed, so the table matches",
    ],
  },
  {
    types: ["Liquor glasses"],
    ask: ["For whisky, highballs or wine?", "For your outlet, or home or gift?"],
    chips: [["Whisky or brandy", "Highball or G&T", "Wine or champagne"], ["Bar or restaurant", "Home or gift"]],
    fit: [
      "whisky or brandy: a short rocks or double old fashioned tumbler, about 300-370ml for ice; smaller if neat",
      "highball or G&T: a tall longdrink glass; a gin tonic glass for G&T",
      "wine or champagne: an all-round red wine glass, about 450-550ml; a flute for champagne",
      "bar or restaurant: single glasses; look for dishwasher safe; replacements: same glass and ml",
      "home or gift: a set",
    ],
    goes_with: ["Ice buckets, wine buckets and stands", "Storage and warewashing racks and dollies"],
    watch: [
      "check the pack size (piece, set or box) before taking a quantity",
      "check its data before calling it crystal, lead-free or dishwasher safe",
    ],
  },
  {
    types: ["Bowls"],
    ask: ["For rice or soup, noodles, or salad and dessert?", "Porcelain, or melamine (hard plastic)?"],
    chips: [["Rice or soup", "Noodles", "Salad or dessert"], ["Porcelain", "Melamine"]],
    fit: [
      "rice or soup: a small bowl, about 10-13cm, 150-450ml",
      "noodles or a soup meal: a wide noodle bowl, about 16-22cm, 600-1000ml; sharing: over 1000ml",
      "salad or dessert: salad about 15-20cm, 450-950ml; dessert about 150-250ml",
      "porcelain: white for daily use; reactive glaze or stoneware for a rustic look; chip-resistant in its data",
      "melamine: look for break-resistant or shatter-proof in its data",
    ],
    goes_with: ["Asian spoons and ladles", "Plates and platters"],
    watch: [
      "check listed cc or ml, or depth, not just diameter; never guess a capacity",
      "microwave or dishwasher: say safe only if its data says so",
    ],
  },
  {
    types: ["Tall (Highball) Tumblers", "Short (Old Fashioned) Tumblers", "Plastic Tumblers"],
    ask: ["Busy outlet, cocktail bar or fine dining, or poolside?", "Tall highball, or short rocks glass?"],
    chips: [["Busy cafe, bar or restaurant", "Cocktail bar or fine dining", "Poolside, events or kids"], ["Tall highball", "Short rocks"]],
    fit: [
      "busy cafe, bar or restaurant: tempered glass; stackable if space is tight",
      "cocktail bar or fine dining: crystal glass or lead-free crystal, thin or fine rim",
      "poolside, events, kids or no glass: polycarbonate for toughness, SAN plastic for a glass look",
      "tall highball: about 300-400ml, bigger for iced drinks; short rocks: about 250-350ml, heavy base preferred",
      "glass racks: width and height must fit",
    ],
    goes_with: ["Storage and warewashing racks and dollies", "Ice buckets, wine buckets and stands"],
    watch: [
      "check pack size (per piece or set) before taking a quantity",
      "say tempered, crystal or shatter-resistant only if its data does",
    ],
  },
  {
    types: ["Frying pans"],
    ask: ["Non-stick, carbon steel, or plain stainless?", "Gas or induction?"],
    chips: [["Non-stick", "Carbon steel or cast iron", "Plain stainless"], ["Gas", "Induction"]],
    fit: [
      "non-stick: coated aluminium for eggs, pancakes and fish; coated stainless for heavy daily use",
      "carbon steel or cast iron: black or blue steel, iron or cast iron, for high-heat searing",
      "plain stainless: uncoated, tri-ply base, for browning and pan sauces",
      "induction: only pans whose data says they work on induction, not 'except induction'",
      "size: 20-24cm for eggs or one portion, 28cm for two, 32cm and up for batches",
    ],
    goes_with: ["Turners, spatulas and paddles", "Cookware lids"],
    watch: [
      "hob not known: pick an induction-usable pan",
      "carbon steel or cast iron: check they're ok to hand wash, dry and oil it",
    ],
  },
  {
    types: ["Sauce pans", "Stock pots"],
    ask: ["Gas or induction?", "Sauces, soups, or big stock batches?"],
    chips: [["Gas", "Induction", "Both or not sure"], ["Sauces", "Soups or stock", "Big batches"]],
    fit: [
      "gas: any pot; layered (tri-ply, capsule or sandwich) base for thick sauces",
      "induction, both or not sure: only if name or data says it works on induction; layered base isn't proof",
      "sauces: sauce pan about 1-4 litres, 14-20cm across; low and wide for reducing, high-sided for boiling",
      "soups or stock: tall stock pot about 10-25 litres, 24-32cm; big batches: tall, 36 litres or 36cm and up",
      "home: a pot with its lid",
    ],
    goes_with: ["Cookware lids", "Kitchen Ladles"],
    watch: [
      "lid: included only if name or data says so",
      "big pot: check it fits their stove and sink",
    ],
  },
  {
    types: ["Cutting boards"],
    ask: ["Round chopping block, or flat board?", "Which size?"],
    chips: [["Round block for cleaver", "Flat board for prep", "Home use"], ["Small", "Standard", "Large"]],
    fit: [
      "round block for cleaver: thick round chopping board, plastic or wood; 4 inch or thicker for big bones",
      "flat board for prep: plastic, 1/2 to 3/4 inch thick; 1 inch for heavy cutting",
      "home use: wood fibre board, hand wash; bar: small plastic board",
      "size: small up to 10x13 inch, round 12; standard 12x18, round 14-16; large 15x20 and up, round 18-20",
      "colour-coding: one colour per food group, raw and cooked apart",
    ],
    goes_with: ["Cutting board accessories"],
    watch: [
      "check it fits the counter, sink and dishwasher rack",
      "say dishwasher safe or anti-bacterial only if its data does",
    ],
  },
  {
    types: ["Dessert spoons", "Dessert forks", "Table forks", "Table spoons", "Table knives"],
    ask: ["Fine dining, restaurant or cafe, or hawker stall?", "Local spoon and fork, or Western knife and fork?"],
    chips: [["Fine dining", "Restaurant or cafe", "Hawker or food court"], ["Local spoon and fork", "Western knife and fork", "Both"]],
    fit: [
      "fine dining: 5mm or thicker; knives also with a heavy solid handle",
      "restaurant or cafe: all-steel; fork and spoon about 3-4mm",
      "hawker or food court: plastic handle (PLC HDLE), or steel described as economical",
      "local spoon and fork: dessert spoon and fork, or table spoon and fork marked Asian",
      "western knife and fork, or both: table knife, fork and spoon",
    ],
    goes_with: ["Flatware organizers and holders", "Tea and demitasse spoons"],
    watch: [
      "same series name on every piece, all in stock; topping up: match theirs",
      "steak on the menu: steak knife from the same series",
    ],
  },
  {
    types: ["Tea and demitasse spoons"],
    ask: ["For a cup or mug, espresso cup, or tall glass?", "Hotel and fine dining, or cafe and kopitiam?"],
    chips: [["Cup or mug", "Espresso cup", "Tall glass"], ["Hotel or fine dining", "Cafe or kopitiam"]],
    fit: [
      "cup or mug: a tea spoon, about 13-14cm",
      "espresso cup: a small espresso, coffee or demitasse spoon, about 10.5-12.5cm",
      "tall glass: a long ice tea or soda spoon, about 18-20cm",
      "hotel or fine dining: 4mm or thicker, stated in its name or description",
      "cafe or kopitiam: about 2.5-3.5mm thick, or basic 18/0 steel",
    ],
    goes_with: ["Cups, saucers and mugs", "Flatware organizers and holders"],
    watch: [
      "check per piece or set before taking a quantity",
      "match any table cutlery they use by series name only",
    ],
  },
  {
    types: ["Kitchen blenders/mixers/cutters", "Bar blenders and Drink mixers", "Immersion blenders, whisks and emulsifiers"],
    ask: ["For drinks, soup in the pot, or pastes and purees?", "Busy all day, now and then, or home use?"],
    chips: [["Drinks and ice", "Soup in the pot", "Pastes and purees"], ["Busy all day", "Now and then", "Home use"]],
    fit: [
      "drinks and ice: bar blender, 3HP or more if busy, sound enclosure at the counter; milkshakes: drink mixer",
      "soup in the pot: stick blender; big pots: longer shaft, bigger max batch; busy: heavy use",
      "pastes and purees: cutter mixer or stainless-jar blender, big jar if busy; soft diets: blender mixer",
      "now and then: compact commercial, 2HP or small jar; home: home-use model or mini chopper",
    ],
    goes_with: ["Accessories for Electricals and Food Prep Machines", "Measuring jugs, cups and spoons"],
    watch: [
      "check single or 3-phase power and the plug",
      "sound enclosure may be optional; check it's included",
    ],
  },
  {
    types: ["Asian pots and casseroles", "Claypots and claypot stands"],
    ask: ["Claypot, steamboat, or stock pot?", "Individual or sharing size?"],
    chips: [["Claypot", "Steamboat or hot pot", "Stock pot"], ["Individual", "Sharing"]],
    fit: [
      "claypot: about 13-18cm for individual, 22-30cm for sharing",
      "steamboat or hot pot: stainless for sharing, divided for yuan yang; non-stick for individual",
      "stock pot: stainless with lid, sized to the batch; pot with tap to draw soup; sauce pot for small batches",
      "Korean: stone bowl for individual, stone chowder pan for sharing; Japanese: deep casserole; Thai: Thai style claypot",
    ],
    goes_with: ["Table-top warmers and stoves", "Kitchen Ladles"],
    watch: [
      "check the stove: on induction, only pots whose name or data says induction usable; never assume clay or stone pots are",
      "claypots: check with cover or body only, and pack size",
    ],
  },
  {
    types: ["Condiment bowls and pots"],
    ask: ["For kitchen prep, serving, or cooking oil?"],
    chips: [["Kitchen prep", "Serving", "Cooking oil"]],
    fit: [
      "kitchen prep: shallow steel mar bowl or mar dish; sauce/condiment bowl for sauces; mar bowl with holes to drain",
      "serving: seasoning dish for dips and condiments; to keep soup or porridge warm, only a bowl described as double-wall",
      "cooking oil: steel oil pot to hold oil; oil filter pot with mesh insert to filter deep-fry oil",
      "steaming: steel steaming bowl",
      "storage: round steel canister",
    ],
    goes_with: ["Asian spoons and ladles", "Strainers"],
    watch: [
      "check the diameter fits the counter, steamer or shelf",
      "some sizes are in inches: convert before comparing",
    ],
  },
  {
    types: ["Drink dispensers"],
    ask: ["Juice or cold drinks, hot coffee or tea, or drinking water?", "Buffet line, small counter, or outdoor catering?"],
    chips: [["Juice or cold drinks", "Hot coffee or tea", "Drinking water"], ["Buffet line", "Small counter", "Outdoor catering"]],
    fit: [
      "juice or cold drinks: glass for looks; polycarbonate, acrylic or stainless if breakage matters",
      "hot coffee or tea: a coffee urn; an airpot (pump flask) for a small counter",
      "drinking water: a water dispenser or cooler",
      "outdoor catering: an insulated server",
      "small counter: about 3-6L; buffet line: 7L or more, or a twin",
    ],
    goes_with: ["Tall (Highball) Tumblers", "Plastic Tumblers"],
    watch: [
      "hot, cold, heating or fuel: only if its data says; hot all day: electric urns in Water boilers and dispensers",
      "stand or ice tube: included or a separate item",
    ],
  },
  {
    types: ["Cups and mugs", "Cups, saucers and mugs"],
    ask: ["Espresso cup, coffee or tea cup, or mug?", "Porcelain, glass, melamine or steel?"],
    chips: [["Espresso cup", "Coffee or tea cup", "Mug"], ["Porcelain", "Glass", "Melamine or steel"]],
    fit: [
      "espresso cup: espresso or demitasse, about 60-100ml",
      "coffee or tea cup: about 150-250ml; cappuccino or latte: cappuccino cup; kopi: thick, old-style cup",
      "mug: about 250-450ml; staff or home: double-wall steel with lid",
      "porcelain: for busy service, stackable, chip-resistant; melamine or steel: melamine for cups, steel for mugs",
      "glass: for hot drinks, its details must say tempered (toughened), heat-resistant or for hot drinks",
    ],
    goes_with: ["Tea and demitasse spoons", "Beverage condiment service"],
    watch: [
      "check if the saucer is included; if not, match it by name or series",
      "check per piece, set or box before taking a quantity",
    ],
  },
  {
    types: ["Rooms and office bins", "Kitchen pedal bins"],
    ask: ["For the kitchen, rooms, or washrooms?", "Big, medium, or small bin?"],
    chips: [["Commercial kitchen", "Room, office or home", "Washroom"], ["Big", "Medium", "Small"]],
    fit: [
      "commercial kitchen: plastic step-on bin with lid; big 68-87L, medium 45L, small 21-35L",
      "room, office or home: stainless step bin with soft-close lid; slim for narrow spaces",
      "washroom: plastic swing top bin, 9-25L; for hotels, a stainless pedal bin or sensor bin",
    ],
    goes_with: ["Garbage bags"],
    watch: [
      "lid included or separate; if separate, offer the lid named for the bin's litres",
      "check the height and floor space fit the spot, such as under a counter",
    ],
  },
  {
    types: ["Chef knives"],
    ask: ["What blade length?", "For kitchen staff, a chef's own knife, or home?"],
    chips: [["Short, light prep", "Standard, all-round", "Long, big veg or bulk prep"], ["Kitchen staff", "Chef's own", "Home"]],
    fit: [
      "short: blade length about 15-18cm (6-7 inch); standard: 20-23cm (8-9 inch); long: 25-31cm (10-12 inch)",
      "kitchen staff: non-slip plastic handle; handle colours suit colour-coded kitchens",
      "chef's own: forged, or a Japanese-style chef knife",
      "home: forged, or one with a blade cover",
      "sturdier option: a forged blade, where its name or data says forged",
    ],
    goes_with: ["Sharpening steels", "Cutting boards"],
    watch: [
      "chopping bones: suggest a cleaver or bone chopper instead",
      "zi char or Chinese kitchen: check if they mean a Chinese slicing knife",
    ],
  },
  {
    types: ["Beverage service accessories"],
    ask: ["Water or cold drinks, hot tea, or coffee?", "Porcelain or glass, stainless steel, or plastic?"],
    chips: [["Water or cold drinks", "Hot tea", "Coffee"], ["Porcelain or glass", "Stainless steel", "Plastic"]],
    fit: [
      "water or cold drinks: pitcher about 1-2L for tables, 2.5-4L with lid for stalls or buffets",
      "hot tea: teapot; built-in filter or strainer for loose leaves",
      "coffee: coffee pot, or plunger to brew; vacuum jug or flask keeps drinks hot",
      "porcelain or glass: glass jug for cold drinks, porcelain or heat-resistant glass for hot",
      "plastic: clear polycarbonate looks like glass; hot drinks only if heat-rated",
    ],
    goes_with: ["Tall (Highball) Tumblers", "Cups, saucers and mugs"],
    watch: [
      "check capacity (cc equals ml) against cups or glasses served",
      "steaming milk: frothing jug, under Hot drinks and specialty items",
    ],
  },
  {
    types: ["Insulated transport containers"],
    ask: ["Soup or rice, GN pans, or ice and cold drinks?", "Big catering, or small deliveries?"],
    chips: [["Soup or rice", "GN pans", "Ice or cold drinks"], ["Big catering", "Small delivery"]],
    fit: [
      "soup or rice: a plastic insulated food bucket",
      "GN pans or packed meals: EPP foam boxes, or pan carriers",
      "ice: an insulated ice bucket; cold drinks: a cooler box",
      "big catering: carriers for several full-size (GN 1/1) pans; small delivery: an EPP foam box",
      "bakery trays: EPP foam boxes for 60x40 trays",
    ],
    goes_with: ["European GN pans", "Ice and flour scoops"],
    watch: [
      "check their pan or tray size and depth; say what fits or is included only if its data does",
      "hot or cold, and hold time; heated carriers need a power point",
    ],
  },
  {
    types: ["Non-induction stoves and ranges", "Induction stoves and cooking stations"],
    ask: ["Wok frying, pots and pans, or tabletop cooking?", "Gas or induction?"],
    chips: [["Wok frying", "Pots and pans", "Steamboat or BBQ"], ["Gas", "Induction"]],
    fit: [
      "wok frying: induction wok stove",
      "gas, for wok or big stockpots: LPG burner marked high pressure",
      "pots and pans: single or double induction cooker; busy kitchen, long hours: one marked professional or heavy-duty",
      "steamboat: portable butane stove, or induction stove for table use; BBQ: gas grill",
      "buffet warming: warming tray",
    ],
    goes_with: ["Asian pots and casseroles", "Gas lighters"],
    watch: [
      "gas burner: check their supply (LPG tank or piped town gas) and regulator match its stated gas and pressure; a stand",
      "induction cooking: check plug and amps against their sockets, any stated max usage time, and magnetic-base pots",
    ],
  },
  {
    types: ["Chafers"],
    ask: ["For catering and parties, or a buffet line?", "Full size, smaller, or round?"],
    chips: [["Catering or parties", "Buffet line"], ["Full size", "Smaller", "Round"]],
    fit: [
      "catering or parties: foldable, stackable or nestable; not induction",
      "buffet line: roll-top, or hydraulic (soft-close) with glass lid or window and a stand; induction if they have induction warmers",
      "full size: GN 1/1, for rice and mains",
      "smaller: GN 2/3, GN 1/2 or square, for sides",
      "round: for curry or gravy; for soup, see Soup stations",
    ],
    goes_with: ["Wax and Gel Fuel", "Serving tongs"],
    watch: [
      "induction: check they have an induction warmer, or will use a stand and fuel",
      "stand and fuel holder: only say included if the name or description says so",
    ],
  },
  {
    types: ["Utility trolleys"],
    ask: ["Clearing tables, kitchen use, or moving goods?", "Plastic, or stainless steel?"],
    chips: [["Clearing tables", "Kitchen use", "Moving goods"], ["Plastic", "Stainless steel"]],
    fit: [
      "clearing tables: plastic 3-tier cart with brakes, quiet wheels or side panels; large if using bus boxes",
      "kitchen use: stainless steel 2- or 3-tier trolley with 2 handles",
      "moving goods: platform (flatbed) trolley; for heavy loads, a cart with a stated max load",
      "plastic: PLC, polypropylene (PP) or structural foam; won't rust or dent",
      "stainless steel: sturdy, for wet kitchens and cold rooms",
    ],
    goes_with: ["Utility boxes"],
    watch: [
      "check its length and width against aisles, doors and lifts",
      "offer add-on side panels or bins only for a cart their data names",
    ],
  },
  {
    types: ["Asian Woks"],
    ask: ["Commercial wok burner, home gas stove, or induction hob?", "Single handle for tossing, or a heavy-duty frying wok?"],
    chips: [["Commercial wok burner", "Home gas stove", "Induction hob"], ["Single handle", "Heavy-duty frying wok"]],
    fit: [
      "commercial wok burner or heavy-duty: heavy-duty iron frying wok; big batches: thicker, deeper (mm and depth in name)",
      "home gas stove: long-handle wok, about 32-36cm (13-14 inch)",
      "induction hob: only woks whose name or data says induction usable",
      "single handle: one-handle wok for tossing, 13-18 inch",
      "easy care: stainless steel",
    ],
    goes_with: ["Asian turners, ladles & wok accessories", "Skimmers and splatter screens"],
    watch: [
      "check it fits their wok ring or induction wok stove's curved bowl, or matches the old wok",
      "iron or black steel: check they're fine with drying and oiling it after washing",
    ],
  },
  {
    types: ["Oven & Stove to Table cookware"],
    ask: ["For stews, bakes, or grilling?", "Single serve, sharing, or buffet?"],
    chips: [["Stew, soup or rice", "Bake or roast", "Grill, fry or hot plate"], ["Single serve", "Sharing or family", "Buffet or big batch"]],
    fit: [
      "stew, soup or rice: deep casserole; low casserole for braises",
      "bake or roast: roasting dish; oval casserole for whole chicken",
      "grill or fry: grill pan, griddle, fry pan; hot plate: plate or skillet on wooden base",
      "single serve: mini casserole, small baking dish or pan on wooden base",
      "sharing or family: 4-6 pax; buffet or big batch: 8-12 pax",
    ],
    goes_with: ["Heat protection gear"],
    watch: [
      "heat source (induction, gas, oven): its data must list theirs; table service: check its weight",
      "lid, wooden base, servings: only as its data gives; never call the wood dishwasher safe",
    ],
  },
  {
    types: ["Asian turners, ladles & wok accessories"],
    ask: ["Wok size: big, medium, or small?", "Is the wok non-stick?"],
    chips: [["Big wok", "Medium wok", "Small or home wok"], ["Yes, non-stick", "No, iron or steel"]],
    fit: [
      "big wok: longer frying turner, bigger ladle bowl; long handle for very big woks or big batches",
      "medium wok: mid-size frying turner or ladle",
      "small or home wok: shorter frying turner, smaller ladle bowl; bakelite handle for home",
      "iron or steel: stainless steel; non-stick: nylon head marked for non-stick cookware",
      "griddle or teppanyaki: teppanyaki turner; sharp-edge steak turner for meat; long handle for big griddles",
    ],
    goes_with: ["Skimmers and splatter screens"],
    watch: [
      "check length and bowl cm in the name, not just the size number",
      "replacing one: match the old one's tahil (ladle size) or length",
    ],
  },
  {
    types: ["Beer stemware", "Beer tumblers", "Beer mugs", "Plastic beer glasses"],
    ask: ["Busy bar or restaurant, craft beer, or poolside?", "Pint glass, tall pilsner, or mug?"],
    chips: [["Busy bar or restaurant", "Craft beer", "Poolside or outdoor"], ["Pint glass", "Tall pilsner", "Mug"]],
    fit: [
      "busy bar or restaurant: tempered nonic tumbler (bulge near the top), or glass mug",
      "coffeeshop or zi char: small plain tumblers; home: the sets of two",
      "craft beer: crystal tulip-shaped stemglass with a thin rim; wheat beer: tall wheat glass",
      "poolside or outdoor: polycarbonate (PC) plastic, not glass",
      "pint glass: nonic tumbler, about 570ml; tall pilsner: slim, tapered glass",
    ],
    goes_with: ["Storage and warewashing racks and dollies", "Beer and wine accessories"],
    watch: [
      "check the pack size (per piece or set) before taking a quantity",
      "check their pour size, leaving room for the foam head",
    ],
  },
  {
    types: ["Digital scales"],
    ask: ["Portioning, bulk ingredients, or tiny amounts?", "Wet area, dry kitchen, or in front of customers?"],
    chips: [["Portioning or baking", "Bulk ingredients", "Tiny amounts"], ["Wet area", "Dry kitchen", "In front of customers"]],
    fit: [
      "portioning or baking: about 5kg, reads to 1g; tare (zeroes the bowl) per its data",
      "bulk ingredients: 7.5-15kg, with room for the container; heavier sacks: see Mechanical scales",
      "tiny amounts: reads finer than 1g, like a pocket scale; check max weight",
      "wet area: waterproof, or splash-proof with a removable stainless tray, per its data; dry kitchen: neither needed",
      "in front of customers: 2-sided display",
    ],
    goes_with: ["Measuring jugs, cups and spoons", "Kitchen timers"],
    watch: [
      "battery or plug-in; adaptor: say only what its data says",
      "selling by weight: Sia Huat sales confirms if it's trade-approved",
    ],
  },
  {
    types: ["Condiment and Hor d'ouevres dishes"],
    ask: ["Porcelain, or melamine (hard plastic)?", "For soy or chilli, dips or desserts, or canapés?"],
    chips: [["Porcelain", "Melamine"], ["Soy or chilli", "Dips or desserts", "Canapés or finger food"]],
    fit: [
      "porcelain: plain white for classic service; a coloured glaze for a modern look",
      "melamine: for hawkers, food courts and canteens",
      "soy or chilli: a shallow sauce dish, about 7-10cm; a divided dish for several sauces",
      "dips or desserts: a ramekin; small for dips, larger for desserts",
      "canapés: porcelain hors d'oeuvre dishes or canape spoons; in melamine, small shell or square dishes",
    ],
    goes_with: ["Condiment bottles, sets and racks", "Plates and platters"],
    watch: [
      "baking in it: only if its data allows oven use; never melamine",
      "to match their plates: same series and colour in both product names",
    ],
  },
  {
    types: ["Asian spoons and ladles", "Soup spoons"],
    ask: ["Porcelain, melamine, or stainless steel?", "Chinese spoon, ramen spoon, or Western soup spoon?"],
    chips: [["Porcelain", "Melamine", "Stainless steel"], ["Chinese spoon", "Ramen spoon", "Western soup spoon"]],
    fit: [
      "porcelain: for Chinese restaurants, dim sum and home; a Chinese spoon from their bowls' range if known",
      "melamine: Chinese or ramen spoons for hawkers, kopitiams, food courts and kids",
      "stainless steel or Western soup spoon: from their cutlery's range if known; fine dining 5mm and up, cafes 3-4mm",
      "Chinese spoon: about 13-15cm; ramen spoon: about 16-17cm",
      "sharing soup: a soup ladle, same material as the spoons; hot pot: only one described for hot pot",
    ],
    goes_with: ["Bowls", "Chinese chopsticks"],
    watch: [
      "check the pack size (per piece or set) before taking a quantity",
    ],
  },
  {
    types: ["Mixing bowls and basins"],
    ask: ["What size: small, medium, or large?", "For mixing, whisking, or washing?"],
    chips: [["Small", "Medium", "Large"], ["Mixing or marinating", "Whisking cream or eggs", "Washing or soaking"]],
    fit: [
      "small: up to about 20cm across, under 2 litres",
      "medium: about 21 to 30cm, 2 to 6 litres",
      "large: over 30cm; catering or central kitchen: 45cm and up; heavy loads: with handles",
      "mixing or marinating: plain flat-base bowl; whisking: round-bottom hemispherical or spherical bowl; washing or soaking: a basin",
      "microwave: only a bowl whose name or data says microwaveable or microwave-safe",
    ],
    goes_with: ["Whisks", "Colanders"],
    watch: [
      "stand mixer bowl: a mixer accessory; ask which mixer model",
      "same diameter can hold different litres; give litres only if the product lists them",
    ],
  },
  {
    types: ["Planetary and spiral mixers"],
    ask: ["Bread or pizza dough, cakes and creams, or home baking?", "Small batches, or big batches?"],
    chips: [["Bread or pizza dough", "Cakes and creams", "Home baking"], ["Small batches", "Big batches"]],
    fit: [
      "bread or pizza dough: spiral mixer, or a planetary one whose data gives kg of dough",
      "cakes and creams: planetary mixer whose data lists a whisk and paddle",
      "home baking: stand mixer, about 5 to 7L; for bread, 1000W or more",
      "small batches: about 10L; big batches: 20 to 30L; compare kg capacity, not bowl litres",
    ],
    goes_with: ["Digital scales", "Pastry spatulas and scrapers"],
    watch: [
      "commercial: check single or 3-phase power, bench or floor space and safety guard; skip any marked domestic use",
      "check which attachments its data lists: dough hook, paddle, whisk",
    ],
  },
  {
    types: ["Waffle and crepe machines"],
    ask: ["Belgian or Liège (sugar dough) waffles, or crepes?", "Single, double, or home use?"],
    chips: [["Belgian waffles", "Liège waffles", "Crepes"], ["Single", "Double", "Home use"]],
    fit: [
      "Belgian waffles: one listed as rotary with non-stick plates; cast iron Brussels mould for heavier use",
      "Liège waffles: a cast iron Liège mould that takes frozen dough",
      "crepes: a lower-wattage machine; enamelled cast iron for busy stalls, mobile for events",
      "double: a double or twin that makes two at once",
      "home use: a mini Belgian maker; domestic models suit home only",
    ],
    goes_with: ["Food portioners and ice cream scoops", "Sauce bottles and squeeze dispensers"],
    watch: [
      "check its power data (16A plug, 20A breaker, 380V three-phase) against the customer's supply",
      "crepes: check if its data lists a spreader and spatula",
    ],
  },
  {
    types: ["Cake & pastry moulds"],
    ask: ["For cakes, tarts, or mousse?", "Individual portions, whole, or a tray bake?"],
    chips: [["Cakes", "Tarts", "Mousse or frozen"], ["Individual portions", "Whole", "Tray bake"]],
    fit: [
      "cakes, whole: round, square or loaf tins; uncoated angel food pan for chiffon; springform for cheesecake",
      "cakes, individual portions: muffin, madeleine or financier trays",
      "tray bake: 3cm-deep bake pan for sponge sheets, 5cm for brownies; 60x40 must fit their oven",
      "tarts: loose-bottom fluted moulds for whole; small aluminium or non-stick for egg tarts, tartlets",
      "mousse or frozen: silicone or stainless steel for portions; large silicone mould for whole",
    ],
    goes_with: ["Wire grids and cooling racks", "Baking mats and papers"],
    watch: [
      "check per piece or per pack before taking a quantity",
      "check the stated temperature limit before saying oven- or freezer-safe",
    ],
  },
  {
    types: ["Combination food processors"],
    ask: ["For home, a cafe or stall, or a restaurant?", "Just chopping and pastes, or slicing and grating too?"],
    chips: [["Home use", "Cafe or stall", "Restaurant or catering"], ["Just chopping and pastes", "Slicing and grating too"]],
    fit: [
      "home use: food processor about 2L; mini chopper for small jobs",
      "cafe or stall: commercial model, stainless bowl about 3-4L",
      "restaurant or catering: stainless bowl from 4.5L",
      "just chopping and pastes: a model without discs is fine",
      "slicing and grating too: veg slicer lid with the discs needed; only some models can dice",
    ],
    goes_with: ["Accessories for Electricals and Food Prep Machines"],
    watch: [
      "discs: confirm the cuts; say included, or that a disc fits, only if product data says so",
      "3-phase (heavy-duty 400V) models: check the kitchen has that supply",
    ],
  },
  {
    types: ["Vacuum sealing machines"],
    ask: ["Liquids and marinades too, or solid food only?", "Small portions, or big cuts and batches?"],
    chips: [["Liquids or marinades", "Solid food only", "Home use"], ["Small portions", "Big cuts or batches"]],
    fit: [
      "liquids or marinades: a chamber machine (whole bag goes inside); prefer one whose data lists soft vacuum or marinating",
      "solid food only: a commercial or stainless steel external suction machine",
      "home use: a compact external suction sealer",
      "small portions: a seal bar around 30cm, or a smaller chamber",
      "big cuts or batches: a 40cm or longer seal bar, or a large, deep chamber",
    ],
    goes_with: ["Disposable vacuum packaging bags", "Food rotation labels and dispensers"],
    watch: [
      "match bags by their data: embossed (textured) for external suction, plain for chamber",
      "bags must fit the seal bar, items the chamber",
    ],
  },
  {
    types: ["Turners, spatulas and paddles"],
    ask: ["For flipping, scraping, or stirring big pots?", "Non-stick pans, steel pans and griddles, or iron woks?"],
    chips: [["Flipping", "Scraping or mixing", "Stirring big pots"], ["Non-stick", "Steel or griddle", "Iron wok"]],
    fit: [
      "non-stick: nylon, silicone or wooden head to protect the coating",
      "steel or griddle: stainless slotted turner, fish turner for delicate food; wide heavy-duty, burger or teppanyaki turner for griddles",
      "iron wok: stainless frying turner; more sizes in Asian turners, ladles & wok accessories",
      "scraping or mixing: silicone spatula; spoon spatula for sauces",
      "stirring big pots: long stainless stirring spatula or wooden paddle",
    ],
    goes_with: ["Kitchen tongs and tweezers", "Whisks"],
    watch: [
      "nylon or silicone on high heat: check the product's heat rating",
      "big pots: check the length against the pot depth",
    ],
  },
  {
    types: ["Rice cookers"],
    ask: ["For home, a cafe, or a restaurant, stall or caterer?", "Electric, town gas, or LPG?"],
    chips: [["Home", "Cafe or light use", "Restaurant, stall, catering"], ["Electric", "Town gas", "LPG cylinder"]],
    fit: [
      "home: an electric rice cooker under 5L that lists keep-warm",
      "cafe or light use: a 5-6L non-stick electric rice cooker",
      "restaurant, stall, catering: a non-stick rice cooker of about 10L, or stainless listing max kg of rice",
      "town gas: a gas rice cooker; (Pub) in the name means town gas",
      "LPG: only a rice cooker named LPG; if none, offer electric",
    ],
    goes_with: ["Rice scoops and forks", "Rice warmers"],
    watch: [
      "litres may mean the pot, not the rice; compare the same measure",
      "big electric ones: check the plug and wattage suit their socket",
    ],
  },
  {
    types: ["Ice makers"],
    ask: ["Cube ice, clear ice, or ice cream?"],
    chips: [["Cube ice for drinks", "Clear ice for cocktails", "Ice cream or sorbet"]],
    fit: [
      "cube ice: a cube ice maker, not a clear ice maker; check ice output per day and cube size",
      "clear ice: a clear ice maker",
      "ice cream or sorbet: built-in compressor, no bowl to pre-freeze, batch after batch; freezer-bowl type for home or occasional use",
      "shaved ice or ice kachang: an ice shaver; see Ice crushers and shavers",
    ],
    goes_with: ["Food portioners and ice cream scoops", "Ice and flour scoops"],
    watch: [
      "clear ice maker: check if its mould is included; offer only its own mould",
      "check their space and any water pipe or drain against its details; for shop use, flag any domestic-use marking",
    ],
  },
  {
    types: ["Juice extractors and Citrus juicers"],
    ask: ["Citrus only, fruit and veg, or cold-pressed juice?", "Heavy use, light use, or for home?"],
    chips: [["Citrus only", "Fruit and veg", "Cold-pressed"], ["Heavy use", "Light use", "Home"]],
    fit: [
      "citrus only: a citrus juicer; heavy use: lever-operated, or listed as high output; light use: a standard one",
      "fruit and veg: a centrifugal (spinning) extractor; heavy use: takes whole fruit, big pulp container; light use: compact commercial",
      "cold-pressed, slow juicer or leafy greens: a cold press juicer",
      "home: a smaller household juicer",
      "self-service buffet: one made for self-service",
    ],
    goes_with: ["Tall (Highball) Tumblers", "Bar blenders and Drink mixers"],
    watch: [
      "citrus: check the squeezers suit the fruit, from lime to grapefruit",
      "check counter space, height under any shelf, and spout height for a glass or jug",
    ],
  },
  {
    types: ["Cocktail and liquor accessories"],
    ask: ["Mostly shaken, stirred, or wine service?", "For a bar, a restaurant or cafe, or home?"],
    chips: [["Shaken", "Stirred", "Wine service"], ["Bar", "Restaurant or cafe", "Home"]],
    fit: [
      "shaken, bar: Boston shaker tins and a four-prong (Hawthorne) strainer; restaurant, cafe or home: three-piece shaker or cocktail set",
      "stirred: mixing glass, long bar spoon and julep strainer",
      "measuring spirits: a dual jigger; heavy or Japanese style for bars",
      "wine service: waiter's friend corkscrew; vacuum pump set for opened bottles; champagne stopper for sparkling",
    ],
    goes_with: ["Ice buckets, wine buckets and stands", "Short (Old Fashioned) Tumblers"],
    watch: [
      "jigger: match the cup sizes to their standard pour (spirit per drink)",
      "Boston tins: check they have a second tin or glass, and a strainer",
    ],
  },
  {
    types: ["Chinese bone knives and choppers", "Chinese Jiu Jiang (Kow Kong) knives", "Chinese Wen Woo (Mun Mo) knives", "Chinese utility knives and choppers", "Chinese slicing knives", "Chinese vegetable knives", "Cleavers"],
    ask: ["Chopping bones, slicing, or both?", "Which bones: chicken and fish, or big pork and beef?"],
    chips: [["Chopping bones", "Slicing meat or veg", "Both"], ["Chicken, duck or fish", "Pork or beef bones"]],
    fit: [
      "chicken, duck or fish: small bone chopper; spare ribs too: Kow Kong whose data says so",
      "pork or beef bones: bone knife whose data says big or hard bones",
      "slicing meat or veg: slicer, or vegetable knife if veg only; data must say thin or lightweight",
      "both or home: Mun Mo whose data says front slices, back takes small bones; crab: dual-purpose cleaver",
    ],
    goes_with: ["Sharpening stones", "Cutting boards"],
    watch: [
      "slicer: check nothing they cut has bones, like roast duck",
      "iron blade: check they will wipe it dry after washing",
    ],
  },
];

const byType = new Map(BUYING_GUIDES.flatMap((guide) => guide.types.map((type) => [type.toLowerCase(), guide] as const)));

export const guideOf = (product: Pick<Product, "third_category" | "subcategory">) =>
  byType.get((product.third_category || product.subcategory || "").toLowerCase()) ?? null;

const PER_RESULT = 2;
const PER_TURN = 3; // a 12-code list would otherwise carry a guide per product

/** The guides for these products' types, in result order: at most two, none already sent this turn (sent is updated). */
export function guidesFor(products: readonly Pick<Product, "third_category" | "subcategory">[], sent: Set<BuyingGuide>) {
  const found: BuyingGuide[] = [];
  for (const product of products) {
    const guide = guideOf(product);
    if (guide && !sent.has(guide) && found.length < PER_RESULT && sent.size < PER_TURN) {
      found.push(guide);
      sent.add(guide);
    }
  }
  return found;
}
