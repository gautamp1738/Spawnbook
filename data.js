/* Breakout Report data. Replaced each week; the page reads window.BR. */
window.BR = {
  META: {
    snapshot: "Oct 23, 2026",
    issueNote: "Players counted at 1:29 AM Pacific. Visits measured from 6:58 PM the evening before.",
    checked: 707,
    pool: 94,
    readings: "We read Roblox's public chart lists twice, at 6:58 PM and 1:29 AM Pacific, and pulled each game's public stats. Visits a day is the visits added between the two readings, scaled to 24 hours and cut 20% because US evenings run hot. Players is the live count at the second reading. Games without a first reading use their lifetime average, which is less reliable. Starting Oct 23, we also keep a daily record of every young game, so later issues use daily and weekly averages.",
    playersNote: "one late-night count",
    historyDays: 1,
    picksLogged: 24,
    firstPicks: "2026-10-23",
    issues: 1
  },

  // [pid, name, creator, owner (G group, Gv verified, U solo, Gbig group with 1M+ members), genre, genre2, age days, players,
  //  visits/day, fresh reading, accel, min/visit, rating, favs/1K, votes/1K, hrs since update, Up-and-Coming,
  //  Top Trending, Top Earning, Top Revisited, genre trending, shape, trend wave, component points, score,
  //  measured price months or null, extra {passes, pmin, pmax, members, discord, cid, ctype, pgrowth7, decay}]
  BOARD: [
    [115068315659966, "[🎃] Roll A Stickman!", "Ultrain Studios", "G", "Simulation", "Incremental Simulator", 42, 7998, 382447, 1, 9.5, 30.1, 95.6, 13.6, 5.9, 10, 48, 0, 97, 0, 0, "rocket", 1, "23/22/15/3/8/8", 79, null, {"cid": 32966386, "ctype": "Group", "discord": 0, "members": 62280, "passes": 10, "pmax": 399, "pmin": 149, "pgrowth7": null, "decay": null}],
    [77993383305312, "Feed the Fire 🔥", "BIGGER FIRE", "G", "Simulation", "Incremental Simulator", 85, 3996, 258507, 1, 17.4, 22.3, 97.2, 29.4, 23.2, 0, 0, 42, 0, 0, 24, "rocket", 0, "22/25/12/9/0/8", 76, null, {"cid": 94472127, "ctype": "Group", "discord": 0, "members": 80228, "passes": 18, "pmax": 349, "pmin": 19, "pgrowth7": null, "decay": null}],
    [126608757616138, "[UPD✨] Makeup Salon💄", "Makeup Salon Community", "G", "Roleplay & Avatar Sim", "Dress Up", 18, 12772, 730981, 1, 2.2, 25.2, 97.6, 17.3, 5.8, 11, 36, 0, 0, 0, 6, "staircase", 0, "17/24/12/13/0/8", 74, null, {"cid": 198582770, "ctype": "Group", "discord": 0, "members": 610819, "passes": 5, "pmax": 399, "pmin": 99, "pgrowth7": null, "decay": null}],
    [131488313787599, "[WORLD 2] Bullets VS Everything", "CCU Explosion", "G", "Simulation", "Incremental Simulator", 18, 2404, 159738, 1, 3.8, 21.7, 93.9, 34.3, 7.6, 1, 20, 59, 0, 0, 34, "rocket", 0, "22/22/12/9/0/8", 73, null, {"cid": 358598606, "ctype": "Group", "discord": 0, "members": 124085, "passes": 13, "pmax": 299, "pmin": 49, "pgrowth7": null, "decay": null}],
    [132239307080610, "[🎃] Deep Fishing🎣", "LazyGames.", "Gv", "Simulation", "Incremental Simulator", 96, 10252, 492987, 1, 3.1, 29.9, 97.2, 13.3, 2.5, 44, 0, 58, 74, 0, 32, "staircase", 0, "15/20/12/13/8/5", 73, null, {"cid": 34744238, "ctype": "Group", "discord": 0, "members": 812879, "passes": 9, "pmax": 599, "pmin": 99, "pgrowth7": null, "decay": null}],
    [75687962646869, "[🎃] +1 Gun Forge", "Battle Carrots", "G", "Simulation", "Incremental Simulator", 35, 3368, 145511, 1, 5.3, 33.3, 95.8, 37.6, 6.3, 2, 80, 0, 0, 0, 0, "rocket", 1, "20/25/15/3/0/8", 71, null, {"cid": 532212340, "ctype": "Group", "discord": 0, "members": 186099, "passes": 18, "pmax": 1999, "pmin": 19, "pgrowth7": null, "decay": null}],
    [113384248926706, "[🌧️] Harpoon a Fish", "FirstTry", "G", "Simulation", "Tycoon", 56, 5369, 332875, 1, 3.9, 23.2, 97.2, 4.6, 7.1, 1, 65, 82, 0, 0, 43, "staircase", 0, "18/20/12/13/0/8", 71, null, {"cid": 876860520, "ctype": "Group", "discord": 0, "members": 87869, "passes": 7, "pmax": 499, "pmin": 149, "pgrowth7": null, "decay": null}],
    [114574503491412, "Anime Zero [SOLAR RADIANCE ☀️]", "LY*", "G", "RPG", "Action RPG", 99, 9479, 534430, 0, null, 25.5, 97.4, 3.9, 2.6, 18, 0, 0, 30, 0, 21, "staircase", 0, "7/20/12/13/10/8", 70, null, {"cid": 861404864, "ctype": "Group", "discord": 0, "members": 579043, "passes": 5, "pmax": 899, "pmin": 149, "pgrowth7": null, "decay": null}],
    [114125816375987, "[🎃TD] Survive The Night", "Duni&Minion", "G", "Strategy", "Tower Defense", 114, 2959, 110870, 0, null, 38.4, 96.2, 6.3, 2.4, 0, 0, 0, 80, 0, 25, "staircase", 0, "7/19/15/13/8/8", 70, null, {"cid": 60101259, "ctype": "Group", "discord": 0, "members": 114627, "passes": 2, "pmax": 399, "pmin": 99, "pgrowth7": null, "decay": null}],
    [126256942507957, "Pixel Lineage [🎃Spear Class + Dragon Race]", "Pixel Lineage", "G", "RPG", "Turn-based RPG", 28, 6033, 912010, 1, 1.8, 9.5, 98.9, 6.8, 6.9, 7, 78, 77, 56, 0, 5, "staircase", 0, "15/13/12/13/8/8", 69, null, {"cid": 362755399, "ctype": "Group", "discord": 0, "members": 212323, "passes": 1, "pmax": 250, "pmin": 250, "pgrowth7": null, "decay": null}],
    [123184865562509, "Make Rugs!", "Playmade", "G", "Simulation", "Tycoon", 15, 6935, 390566, 1, 2.0, 25.6, 94.6, 16.5, 4.4, 4, 24, 39, 0, 0, 19, "rocket", 0, "21/22/9/9/0/8", 69, null, {"cid": 719686217, "ctype": "Group", "discord": 0, "members": 12085, "passes": 8, "pmax": 549, "pmin": 49, "pgrowth7": null, "decay": null}],
    [111053011787075, "[RELEASE] Candy Kingdom Defense", "Monero Studios", "G", "Strategy", "Tower Defense", 24, 5082, 629678, 1, 11.1, 11.6, 95.8, 9.8, 3.6, 1, 25, 70, 0, 0, 7, "staircase", 0, "25/10/12/13/0/8", 68, null, {"cid": 35554705, "ctype": "Group", "discord": 0, "members": 10719, "passes": 7, "pmax": 799, "pmin": 79, "pgrowth7": null, "decay": null}],
    [77811814730971, "[ UPD 2🎃] Card Battles: Prestige", "Bronies Development Studio", "G", "Simulation", "Idle", 58, 1674, 69482, 1, 4.2, 34.7, 93.6, 1.1, 1.4, 0, 0, 0, 0, 55, 0, "rocket", 0, "16/20/15/9/0/8", 68, null, {"cid": 302332574, "ctype": "Group", "discord": 0, "members": 9193, "passes": 4, "pmax": 699, "pmin": 199, "pgrowth7": null, "decay": null}],
    [140510877927109, "Pixel Basketball", "Pixel:Games", "G", "Sports & Racing", "Sports", 31, 1104, 155500, 1, 8.3, 10.2, 95.2, 16.2, 13.1, 32, 33, 91, 0, 0, 5, "staircase", 0, "24/13/9/13/0/8", 67, null, {"cid": 217333714, "ctype": "Group", "discord": 0, "members": 25407, "passes": 5, "pmax": 499, "pmin": 99, "pgrowth7": null, "decay": null}],
    [109440485612336, "What If Disasters", "random named group i hvent named yet", "G", "Survival", "", 18, 6557, 492010, 1, 4.1, 19.2, 90.4, 10.5, 3.2, 0, 13, 36, 0, 0, 10, "staircase", 0, "24/13/9/13/0/8", 67, null, {"cid": 34216976, "ctype": "Group", "discord": 0, "members": 3592, "passes": 3, "pmax": 299, "pmin": 99, "pgrowth7": null, "decay": null}],
    [74629631798007, "[🍀 X3] Pets Universe!", "Lip Builds", "Gv", "Simulation", "Incremental Simulator", 60, 4065, 168758, 0, null, 34.7, 98.4, 18.0, 8.7, 15, 0, 0, 86, 0, 0, "rocket", 0, "7/25/12/9/8/5", 66, null, {"cid": 35939768, "ctype": "Group", "discord": 0, "members": 275326, "passes": 8, "pmax": 1995, "pmin": 60, "pgrowth7": null, "decay": null}],
    [75815532269840, "PINKIE PROMISE [HORROR]", "Party Cannon Studios", "G", "", "", 17, 2295, 212172, 1, 6.8, 15.6, 95.0, 38.7, 10.5, 25, 51, 0, 0, 0, 0, "rocket", 0, "23/20/6/9/0/8", 66, null, {"cid": 535217792, "ctype": "Group", "discord": 0, "members": 6988, "passes": 5, "pmax": 699, "pmin": 49, "pgrowth7": null, "decay": null}],
    [116448925875915, "[🌍WORLD 2] +1 Venom Evolution", "Bottled Potential", "Gbig", "Simulation", "Incremental Simulator", 18, 14406, 1039286, 1, 3.3, 20.0, 96.6, 6.2, 5.2, 0, 16, 40, 0, 0, 20, "rocket", 1, "23/19/12/3/0/3", 60, null, {"cid": 401773929, "ctype": "Group", "discord": 0, "members": 1999409, "passes": 5, "pmax": 1299, "pmin": 79, "pgrowth7": null, "decay": null}],
    [119263815547952, "Army Commander Tycoon [UPDATE 3]", "sad builderboy", "G", "Simulation", "Tycoon", 25, 6334, 281572, 1, 1.7, 32.4, 92.9, 5.9, 1.7, 0, 67, 65, 100, 0, 37, "rocket", 0, "13/15/12/9/8/8", 65, null, {"cid": 6769949, "ctype": "Group", "discord": 0, "members": 6750, "passes": 33, "pmax": 1499, "pmin": 99, "pgrowth7": null, "decay": null}],
    [132956556682909, "First Person Boxing", "Can You Box?", "G", "Action", "Battlegrounds & Fighting", 25, 2232, 319379, 1, 2.1, 10.1, 92.5, 6.1, 10.4, 0, 28, 26, 145, 0, 4, "staircase", 0, "21/6/9/13/6/8", 63, null, {"cid": 1049098079, "ctype": "Group", "discord": 0, "members": 68208, "passes": 5, "pmax": 199, "pmin": 79, "pgrowth7": null, "decay": null}],
    [71592191727683, "Lanterns [HALLOWEEN!]", "Lanterns HQ", "G", "RPG", "Action RPG", 23, 1236, 147169, 1, 2.6, 12.1, 92.6, 9.5, 4.9, 3, 37, 85, 0, 0, 7, "staircase", 0, "20/10/12/13/0/8", 63, null, {"cid": 556863692, "ctype": "Group", "discord": 0, "members": 12439, "passes": 4, "pmax": 400, "pmin": 250, "pgrowth7": null, "decay": null}],
    [99409088950210, "Survive a Million Monkeys", "gorilla warfare.", "G", "Survival", "", 74, 7925, 930057, 1, 2.4, 12.3, 97.6, 16.7, 4.2, 0, 0, 0, 92, 0, 23, "staircase", 0, "2/17/12/13/8/8", 60, null, {"cid": 882350685, "ctype": "Group", "discord": 0, "members": 213157, "passes": 5, "pmax": 1299, "pmin": 49, "pgrowth7": null, "decay": null}],
    [139165770588984, "Fix My Phone!", "Doubloons", "G", "Simulation", "", 17, 11844, 862353, 1, 4.0, 19.8, 90.4, 44.5, 1.5, 16, 5, 17, 0, 0, 7, "rocket", 0, "24/15/9/9/0/8", 65, null, {"cid": 33240264, "ctype": "Group", "discord": 0, "members": 436337, "passes": 8, "pmax": 499, "pmin": 99, "pgrowth7": null, "decay": null}],
    [126878515897518, "Build A Soccer Club!", "just a fun game i guess", "G", "Sports & Racing", "Sports", 77, 1539, 67791, 0, null, 32.7, 94.1, 3.1, 2.7, 62, 0, 0, 0, 0, 6, "staircase", 0, "13/17/9/13/0/8", 60, null, {"cid": 423611721, "ctype": "Group", "discord": 0, "members": 143590, "passes": 4, "pmax": 349, "pmin": 199, "pgrowth7": null, "decay": null}]
  ],

  // [pid, name, creator, owner, genre, genre2, age, players, total visits, visits/day, fresh, rating, chart ranks]
  BIG: [
    [107778070777162,"Steal An Egg","and Collect Rare Pets","Gv","Simulation","Tycoon",90,1198467,9100698175,76470640,1,91.8,"R39 E3"],
    [114326934417838,"Break and Steal an Egg","ILGames x Eggs","Gv","Simulation","Tycoon",48,110077,222879623,8522712,1,97.5,"E44"],
    [113290951185459,"[🎃] Anime Dice","More & More Games","Gv","Simulation","Incremental Simulator",69,71385,125998773,2530897,1,99.1,"E37"],
    [94891079210424,"🎃 Sell Fries! [Anomaly] 🍟","Pharting","G","Survival","",32,47688,55981667,2554318,1,83.1,"T18 E130"],
    [85738654635245,"Climb For Animals Eggs🥚","100% GRIND","G","Simulation","Tycoon",46,45614,41132954,2972142,1,98.9,"T38"],
    [72858262610964,"[🎃] Tap Simulator REBORN","Cursor Makers","Gv","Simulation","Incremental Simulator",80,37373,13224824,1322125,1,95.3,"T23 U19 E13"],
    [82347957379349,"صيد الضبّان","LL's Studio","G","Simulation","Incremental Simulator",20,33323,20208716,955348,1,95.0,"T47 U23"],
    [107535308163741,"[🎃] Huss Valley","Huss Valley Official","G","Action","Battlegrounds & Fighting",53,33202,179827203,3051920,1,87.7,"E23"],
    [98628861455414,"[🎃] Bike Universe","Bike Universe","G","Simulation","Vehicle Sim",26,30027,11953323,2518431,1,83.7,"T10 U3"],
    [93523763376122,"[☄️] Ride a Dino","and Catch Them All","G","Simulation","Tycoon",60,28427,11127019,1488082,1,98.0,"T14 E106"],
    [74023858073178,"[🎃] Bike For Egg!","Huron Games","G","Simulation","Tycoon",37,27554,13042862,1880592,1,95.5,"U54"],
    [126987974021910,"[UPDATE!] Illegal Soccer","Repotted","Gv","Sports & Racing","Sports",164,26580,222574545,2617775,1,86.4,"E61"],
    [78515283254292,"[🎃] Animal Hospital (Anomaly) 🧪","Animal Anomaly","Gv","Survival","",166,26556,2457293314,2308294,1,93.1,"E84"],
    [132929771812494,"[🎃UPD] Cameraman Tower Defense","Aligators Games","G","Strategy","Tower Defense",58,25442,35071526,2392542,1,98.9,"T25 R4 E41"],
    [130906410042392,"Cat Battles 🐾","Cute Malt Games","G","Action","Battlegrounds & Fighting",17,25267,49087618,4391322,1,73.4,"T12 U9"],
    [94278659624110,"Backseat Rally","No crash plez","G","","",17,24559,16193092,2296164,1,92.8,"T9 U4"],
    [125310131519813,"[🎃V3] Feed A Mosquito","Be Diao VIII","G","Simulation","Tycoon",63,23851,13820485,1559874,1,79.9,"T46"],
    [122840796290491,"[🎃] Kukirin Life [Testing]","Mukbang Lovers","Gbig","Simulation","Vehicle Sim",34,23317,36729565,1512016,1,83.6,"T8 U11 E35"],
    [96510596525082,"[🎃] Ball VS Ball","ATYS 3","Gv","Party & Casual","",72,23248,152464360,1976440,1,88.8,"E58"],
    [103363457515322,"[CH2] 🪵 Chop A Forest","WCT Capital","Gbig","Simulation","Incremental Simulator",32,21866,22623097,1071071,1,93.0,"T13 E49"],
    [74122653145285,"Steel Fighters","WeShowProjects","G","Simulation","Tycoon",45,21779,4200821,1227567,1,90.3,"T41 U8"],
    [97289366402005,"Fake an Egg","Slime Time Studios","Gv","Simulation","Tycoon",19,20056,12198757,1714290,1,89.0,"T51 U18"],
    [119958473240233,"[NEW STAGES]  DONT SPLASH 🎃","slo7th","U","Obby & Platformer","Runner",6,19132,9951788,3645087,1,90.1,"T11 U2"],
    [111543903102439,"[🎃] +1 Stone Skipping","Meow Labs","G","Simulation","Incremental Simulator",48,17701,61825064,942063,1,96.7,"E50"],
    [137151641329864,"RoFront [World PvP]","Torrey Pines","G","Strategy","",27,15799,33776722,2125306,1,82.7,"T16 U12"]
  ],
  BIG_NOTES: {
    "132929771812494": { ip: "Name may reference Skibidi Toilet's Cameraman characters" },
    "122840796290491": { ip: "Name uses Kukirin, a scooter brand" },
    "107778070777162": { note: "Fade too early to call" },
    "78515283254292": { note: "Down about 74% a month", mult: [1, 1.4, 1.5] }
  },
  IP_OFF: [
    [91413789989696, "My Chiikawa Restaurant! 🎃", 2950, 27, "Name references Chiikawa"],
    [116192088324578, "[CO-OP GAMEMODES] FNaF World Multiplayer", 811, 64, "Name references Five Nights at Freddy's"],
    [128913244126628, "[ULTRON] Hide From The Hulk", 1979, 23, "Name references Marvel's Hulk and Ultron"],
    [138460405368255, "[🎃MULTIPLAYER] Start Your Blue Lock Career!", 2620, 46, "Name references Blue Lock"],
    [124172969655058, "Oregon Trail [new!]", 1842, 28, "Name references The Oregon Trail"],
    [132767904294856, "[🎃] Blue Lock Farm", 6473, 70, "Name references Blue Lock"],
    [102053304052438, "DELTARUNE Fight [EXPANDED]", 2105, 73, "Name references DELTARUNE"],
    [127403135954624, "[ Heisei Mothra ] Kaiju Alpha", 5449, 67, "Name references Mothra"],
    [118915268278945, "Adventure Time RPG [Beta]", 1343, 88, "Name references Adventure Time"],
    [99610146753435, "Free Fire Zone (Max)", 5555, 26, "Name references Free Fire. Also 79 favorites per 1,000 visits, among the highest this week"]
  ],
  FLAG_OFF: [
    [124032631078772, "[🎃EVENT] Poly Loot⚔️", 2052, 94, "Estimated 50 minutes per visit, high for its genre. No fresh visit reading"],
    [78490532994307, "Build An Ant Empire", 7967, 112, "Estimated 47 minutes per visit. No fresh visit reading"],
    [106198175232796, "[UPDATE 2.5] Anime Legacy Simulator", 8845, 43, "Estimated 84 minutes per visit. No fresh visit reading"],
    [79389059854988, "⛏️ My Anime Mine", 11594, 65, "Estimated 67 minutes per visit. No fresh visit reading"],
    [70733580049633, "Wash the Car 🧽", 11757, 67, "0.4 votes per 1,000 visits, among the lowest this week"],
    [74641726785011, "[🌱] Grow a Plant", 6172, 26, "92 favorites per 1,000 visits, among the highest this week"],
    [138572313449154, "[🎃] Rally Panic! [2 Player Rally]", 2398, 21, "0.4 votes per 1,000 visits, among the lowest this week"]
  ]
};
