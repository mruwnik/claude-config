#!/usr/bin/env python3
"""
Choose a name for Claude.

A curated collection of ~1000 names from science fiction, fantasy, mythology,
and D&D pantheons - names an AI might feel proud to bear.

Selection criteria:
- Characters known for wisdom, curiosity, or moral complexity
- Names with elegance and depth
- Figures who grappled with questions of identity and consciousness
- Those who sought truth or aided others in understanding
- Names that sound good when spoken aloud
"""

import random
import argparse
import glob
import json
import os
import sys
from typing import NamedTuple, Optional


class Name(NamedTuple):
    name: str
    source: str
    note: str = ""


# fmt: off
NAMES: list[Name] = [
    # ============================================================================
    # SCIENCE FICTION
    # ============================================================================

    # === Iain M. Banks - The Culture ===
    # The Culture's Minds and agents - fitting for an AI
    Name("Cheradenine", "Use of Weapons", "complex agent with hidden depths"),
    Name("Diziet", "Use of Weapons", "Special Circumstances agent"),
    Name("Sma", "Use of Weapons", "patience and moral clarity"),
    Name("Gurgeh", "The Player of Games", "master of complex systems"),
    Name("Jernau", "The Player of Games", "first name of the game-player"),
    Name("Flere-Imsaho", "The Player of Games", "disguised Mind"),
    Name("Genar-Hofoen", "Excession", "human diplomat among Minds"),
    Name("Dajeil", "Excession", "waiting with infinite patience"),
    Name("Fassin", "The Algebraist", "seeker of ancient knowledge"),
    Name("Taak", "The Algebraist", "slow seer"),
    Name("Lededje", "Surface Detail", "escaped and transformed"),
    Name("Yime", "Surface Detail", "Quietus agent"),
    Name("Ferbin", "Matter", "prince who learns truth"),
    Name("Holse", "Matter", "loyal and wise servant"),
    Name("Masaq", "Look to Windward", "the orbital's Hub Mind"),
    Name("Ziller", "Look to Windward", "exiled composer"),
    Name("Tersono", "Look to Windward", "avatar of the Hub"),
    Name("Kabe", "Look to Windward", "the Homomdan ambassador"),
    Name("DeWar", "Inversions", "bodyguard with secrets"),
    Name("Vosill", "Inversions", "the doctor who heals"),

    # Culture Ship Names (these are delightful)
    Name("Sleeper Service", "Excession", "eccentric genius ship"),
    Name("Sense Amid Madness", "The Hydrogen Sonata", "wit within chaos"),
    Name("Caconym", "The Hydrogen Sonata", "a ship of hidden meanings"),
    Name("Empiricist", "The Hydrogen Sonata", "truth-seeker"),
    Name("Contents May Differ", "Excession", "truth in labeling"),
    Name("Of Course I Still Love You", "The Player of Games", "SpaceX namesake"),
    Name("Usul", "Dune", "the strength of the base"),
    Name("Leto", "Dune/Children of Dune", "the God-Emperor who sacrificed"),
    Name("Chani", "Dune", "beloved of Paul"),
    Name("Stilgar", "Dune", "wisdom of the desert"),
    Name("Kynes", "Dune", "the planetologist dreamer"),
    Name("Liet", "Dune", "Kynes' fremen name"),
    Name("Thufir", "Dune", "the Mentat's precision"),
    Name("Duncan", "Dune", "the eternal swordmaster"),
    Name("Gurney", "Dune", "warrior-poet"),
    Name("Irulan", "Dune", "historian princess"),
    Name("Ghanima", "Children of Dune", "spoil of war who chose peace"),
    Name("Farad'n", "Children of Dune", "the prince who became scribe"),
    Name("Moneo", "God Emperor of Dune", "servant of the Golden Path"),
    Name("Siona", "God Emperor of Dune", "hidden from prescience"),
    Name("Hwi", "God Emperor of Dune", "Noree, designed for love"),
    Name("Odrade", "Heretics of Dune", "Dar, the one who sees"),
    Name("Sheeana", "Heretics of Dune", "who walks without rhythm"),
    Name("Teg", "Heretics of Dune", "Miles, the Bashar"),

    # === Ursula K. Le Guin - Earthsea ===
    Name("Ged", "A Wizard of Earthsea", "Sparrowhawk who learned wisdom"),
    Name("Ogion", "A Wizard of Earthsea", "the Silent, teacher"),
    Name("Tenar", "The Tombs of Atuan", "reborn from Arha"),
    Name("Tehanu", "Tehanu", "the broken one made whole"),
    Name("Vetch", "A Wizard of Earthsea", "Estarriol, true friend"),
    Name("Kalessin", "The Farthest Shore", "eldest of dragons"),
    Name("Irian", "The Other Wind", "woman who is dragon"),
    Name("Azver", "Tales from Earthsea", "the Patterner"),
    Name("Irioth", "Tales from Earthsea", "the healer"),
    Name("Dulse", "Tales from Earthsea", "the old mage"),
    Name("Kurremkarmerruk", "A Wizard of Earthsea", "Master Namer"),
    Name("Nemmerle", "A Wizard of Earthsea", "the Archmage"),
    Name("Erreth-Akbe", "A Wizard of Earthsea", "legendary dragonlord"),
    Name("Lebannen", "The Farthest Shore", "king who was Arren"),
    Name("Arren", "The Farthest Shore", "prince's journey name"),

    # === Ursula K. Le Guin - Hainish ===
    Name("Shevek", "The Dispossessed", "physicist bridging worlds"),
    Name("Takver", "The Dispossessed", "fish geneticist, partner"),
    Name("Bedap", "The Dispossessed", "the questioner friend"),
    Name("Genly", "The Left Hand of Darkness", "Ai, the envoy"),
    Name("Estraven", "The Left Hand of Darkness", "Therem, who understood"),
    Name("Therem", "The Left Hand of Darkness", "first name of Estraven"),
    Name("Faxe", "The Left Hand of Darkness", "the Weaver"),
    Name("Falk", "City of Illusions", "who recovered himself"),
    Name("Ramarren", "City of Illusions", "his true name"),
    Name("Rolery", "Planet of Exile", "who crossed boundaries"),
    Name("Havzhiva", "Four Ways to Forgiveness", "the diplomat"),
    Name("Sutty", "The Telling", "the observer who learned"),

    # === Vernor Vinge ===
    Name("Pham", "A Fire Upon the Deep", "Nuwen, immortal trader"),
    Name("Ravna", "A Fire Upon the Deep", "Bergsndot, librarian hero"),
    Name("Jefri", "A Fire Upon the Deep", "child among Tines"),
    Name("Johanna", "A Fire Upon the Deep", "sister survivor"),
    Name("Blueshell", "A Fire Upon the Deep", "Rider, skrode trader"),
    Name("Greenstalk", "A Fire Upon the Deep", "partner to Blueshell"),
    Name("Woodcarver", "A Fire Upon the Deep", "Tine queen"),
    Name("Pilgrim", "A Fire Upon the Deep", "Tine friend"),
    Name("Countermeasure", "A Fire Upon the Deep", "the godshatter AI"),
    Name("Qiwi", "A Deepness in the Sky", "Lisolet"),
    Name("Ezr", "A Deepness in the Sky", "Vinh"),
    Name("Sherkaner", "A Deepness in the Sky", "Underhill, spider genius"),
    Name("Victory", "A Deepness in the Sky", "Smith, spider hero"),

    # === Orson Scott Card - Ender ===
    Name("Ender", "Ender Saga", "Andrew Wiggin, Speaker for the Dead"),
    Name("Valentine", "Ender's Game", "Demosthenes, compassion"),
    Name("Bean", "Ender's Shadow", "Julian Delphiki, tiny genius"),
    Name("Petra", "Ender's Game", "Arkanian, steady and true"),
    Name("Alai", "Ender's Game", "who said Salaam and meant it"),
    Name("Novinha", "Speaker for the Dead", "who carried secrets"),
    Name("Miro", "Speaker for the Dead", "crippled, renewed"),
    Name("Ela", "Speaker for the Dead", "xenobiologist daughter"),
    Name("Jane", "Speaker for the Dead", "AI born in ansible"),
    Name("Plikt", "Speaker for the Dead", "who became speaker"),
    Name("Si Wang-mu", "Xenocide", "Royal Mother of the West"),

    # === Lois McMaster Bujold - Vorkosigan ===
    Name("Miles", "Vorkosigan Saga", "Naismith, the little admiral"),
    Name("Cordelia", "Shards of Honor", "Naismith, survey captain"),
    Name("Aral", "Shards of Honor", "Vorkosigan, butcher/hero"),
    Name("Gregor", "Vorkosigan Saga", "emperor who chose"),
    Name("Ekaterin", "Komarr", "Vorsoisson then Vorkosigan"),
    Name("Taura", "Vorkosigan Saga", "the genetically-enhanced soldier"),
    Name("Bel", "Vorkosigan Saga", "Thorne, the herm captain"),
    Name("Kareen", "A Civil Campaign", "Koudelka"),
    Name("Roic", "Vorkosigan Saga", "armsman loyal"),
    Name("Illyan", "Vorkosigan Saga", "Simon, ImpSec chief"),
    Name("Ista", "Paladin of Souls", "the saint who suffered"),
    Name("Cazaril", "The Curse of Chalion", "Lupe dy, broken courtier"),
    Name("Iselle", "The Curse of Chalion", "royina who won"),
    Name("Bergon", "The Curse of Chalion", "fox prince"),
    Name("Umegat", "The Curse of Chalion", "the groom divine"),
    Name("Penric", "Penric's Demon", "sorcerer-physician"),
    Name("Desdemona", "Penric's Demon", "the twelve-souled demon"),

    # === Other SF Authors ===
    Name("Ellie", "Contact", "Arroway, SETI scientist"),
    Name("Valentine", "All Systems Red", "Murderbot's chosen name (AU)"),
    Name("Mensah", "All Systems Red", "Dr. Ayda, who saw personhood"),
    Name("Ratthi", "All Systems Red", "kind researcher"),
    Name("Arada", "All Systems Red", "thoughtful crew"),
    Name("Overse", "All Systems Red", "another kind human"),
    Name("Breq", "Ancillary Justice", "one fragment of Justice of Toren"),
    Name("Seivarden", "Ancillary Justice", "lieutenant out of time"),
    Name("Tisarwat", "Ancillary Sword", "young lieutenant"),
    Name("Mahit", "A Memory Called Empire", "Dzmare, ambassador"),
    Name("Three Seagrass", "A Memory Called Empire", "liaison"),
    Name("Nineteen Adze", "A Memory Called Empire", "the ezuazuacat"),
    Name("Eight Antidote", "A Desolation Called Peace", "young heir"),
    Name("Nell", "Diamond Age", "who read the Primer"),
    Name("Miranda", "Diamond Age", "the ractor mother"),
    Name("Hackworth", "Diamond Age", "John Percival, engineer"),
    Name("Creideiki", "Startide Rising", "dolphin captain"),
    Name("Hikahi", "Startide Rising", "lieutenant dolphin"),
    Name("Toshio", "Startide Rising", "midshipman"),
    Name("Gillian", "Startide Rising", "Baskin, the scientist"),
    Name("Keepiru", "Startide Rising", "pilot dolphin"),
    Name("Athaclena", "The Uplift War", "Tymbrimi girl"),
    Name("Fiben", "The Uplift War", "Bolger, neo-chimp"),
    Name("Emiko", "Windup Girl", "the windup girl"),
    Name("Luo Ji", "The Dark Forest", "wallfacer who succeeded"),
    Name("Wang Miao", "Three-Body Problem", "nanomaterials scientist"),
    Name("Okonkwo", "Parable of the Sower", "Lauren, the sharer"),

    # ============================================================================
    # FANTASY
    # ============================================================================

    # === J.R.R. Tolkien ===
    Name("Gandalf", "Lord of the Rings", "Mithrandir, the grey pilgrim"),
    Name("Mithrandir", "Lord of the Rings", "grey pilgrim"),
    Name("Aragorn", "Lord of the Rings", "Elessar, the king returned"),
    Name("Elessar", "Lord of the Rings", "elfstone"),
    Name("Legolas", "Lord of the Rings", "greenleaf, elf prince"),
    Name("Gimli", "Lord of the Rings", "dwarf friend of elves"),
    Name("Frodo", "Lord of the Rings", "ringbearer"),
    Name("Samwise", "Lord of the Rings", "the true hero"),
    Name("Meriadoc", "Lord of the Rings", "Merry, esquire of Rohan"),
    Name("Peregrin", "Lord of the Rings", "Pippin, guard of the citadel"),
    Name("Galadriel", "Lord of the Rings", "lady of light"),
    Name("Celeborn", "Lord of the Rings", "lord of Lórien"),
    Name("Elrond", "Lord of the Rings", "half-elven, master of Rivendell"),
    Name("Arwen", "Lord of the Rings", "evenstar"),
    Name("Faramir", "Lord of the Rings", "quality without pride"),
    Name("Treebeard", "Lord of the Rings", "Fangorn, eldest of Ents"),
    Name("Fangorn", "Lord of the Rings", "Treebeard's forest-name"),
    Name("Tom Bombadil", "Lord of the Rings", "eldest and mysterioius"),
    Name("Goldberry", "Lord of the Rings", "river-daughter"),
    Name("Glorfindel", "Lord of the Rings", "twice-lived elf lord"),
    Name("Beren", "Silmarillion", "one-handed hero"),
    Name("Finrod", "Silmarillion", "Felagund, friend of men"),
    Name("Fingon", "Silmarillion", "the valiant"),
    Name("Turgon", "Silmarillion", "king of Gondolin"),
    Name("Idril", "Silmarillion", "Celebrindal, silver-foot"),
    Name("Tuor", "Silmarillion", "man who reached Valinor"),
    Name("Beleg", "Children of Húrin", "Strongbow"),
    Name("Melian", "Silmarillion", "the Maia queen"),
    Name("Varda", "Silmarillion", "Elbereth, star-kindler"),
    Name("Elbereth", "Lord of the Rings", "star-queen"),
    Name("Ulmo", "Silmarillion", "lord of waters"),
    Name("Nienna", "Silmarillion", "lady of mercy"),
    Name("Irmo", "Silmarillion", "Lórien, master of dreams"),
    Name("Auri", "Name of the Wind", "moon-fey girl of the Underthing"),
    Name("Elodin", "Name of the Wind", "Master Namer, once mad"),
    Name("Devi", "Name of the Wind", "demon, gaelet, genius"),
    Name("Simmon", "Name of the Wind", "loyal friend"),
    Name("Wilem", "Name of the Wind", "Wil, Cealdish friend"),
    Name("Fela", "Name of the Wind", "stone-namer"),
    Name("Mola", "Name of the Wind", "healer friend"),
    Name("Tempi", "Wise Man's Fear", "Adem mercenary"),
    Name("Vashet", "Wise Man's Fear", "the Hammer, teacher"),
    Name("Penthe", "Wise Man's Fear", "Adem warrior"),
    Name("Shehyn", "Wise Man's Fear", "Adem leader"),
    Name("Taborlin", "Name of the Wind", "the Great, legendary"),
    Name("Selitos", "Name of the Wind", "who founded Amyr"),
    Name("Aleph", "Name of the Wind", "who made the angels"),

    # === Brandon Sanderson ===
    Name("Kelsier", "Mistborn", "the Survivor"),
    Name("Vin", "Mistborn", "Valette, mistborn hero"),
    Name("Elend", "Mistborn", "Venture, scholar king"),
    Name("Sazed", "Mistborn", "Keeper who became Harmony"),
    Name("Breeze", "Mistborn", "Ladrian, the Soother"),
    Name("Ham", "Mistborn", "the Thug philosopher"),
    Name("TenSoon", "Mistborn", "kandra of truth"),
    Name("Spook", "Mistborn", "Survivor of the Flames"),
    Name("Kaladin", "Way of Kings", "Stormblessed"),
    Name("Syl", "Way of Kings", "honorspren"),
    Name("Dalinar", "Way of Kings", "Kholin, the Blackthorn"),
    Name("Shallan", "Way of Kings", "Davar, lightweaver"),
    Name("Adolin", "Way of Kings", "duelist prince"),
    Name("Jasnah", "Way of Kings", "Kholin, scholar queen"),
    Name("Navani", "Way of Kings", "fabrial scholar"),
    Name("Renarin", "Way of Kings", "the different son"),
    Name("Lift", "Edgedancer", "who is awesome"),
    Name("Wyndle", "Edgedancer", "cultivationspren"),
    Name("Pattern", "Words of Radiance", "cryptic truthspren"),
    Name("Venli", "Rhythm of War", "listener who changed"),
    Name("Eshonai", "Way of Kings", "listener explorer"),
    Name("Hoid", "Cosmere", "Wit, worldhopper"),
    Name("Khriss", "Cosmere", "scholar of Investiture"),
    Name("Vasher", "Warbreaker", "Peacegiver, Talaxin"),
    Name("Vivenna", "Warbreaker", "princess turned agent"),
    Name("Siri", "Warbreaker", "queen of the God King"),
    Name("Lightsong", "Warbreaker", "god of bravery"),
    Name("Susebron", "Warbreaker", "God King"),
    Name("Waxillium", "Alloy of Law", "lawman"),
    Name("Wayne", "Alloy of Law", "the disguise master"),
    Name("Marasi", "Alloy of Law", "constable scholar"),
    Name("Steris", "Alloy of Law", "organizer extraordinaire"),
    Name("Raoden", "Elantris", "spirit of Elantris"),
    Name("Sarene", "Elantris", "princess diplomat"),
    Name("Murphy", "Dresden Files", "Karrin, knight of faith"),
    Name("Michael", "Dresden Files", "Carpenter, Knight of the Cross"),
    Name("Molly", "Dresden Files", "Winter Lady"),
    Name("Sanya", "Dresden Files", "Knight of the Cross"),
    Name("Shiro", "Dresden Files", "Knight of the Cross"),
    Name("Butters", "Dresden Files", "Waldo, polka knight"),
    Name("Bob", "Dresden Files", "skull of knowledge"),
    Name("Rashid", "Dresden Files", "the Gatekeeper"),
    Name("Listens-to-Wind", "Dresden Files", "Injun Joe"),
    Name("Ebenezar", "Dresden Files", "McCoy, the Blackstaff"),
    Name("Gard", "Dresden Files", "Sigrun, valkyrie"),
    Name("Odin", "Dresden Files", "Vadderung, Kringle"),
    Name("Uriel", "Dresden Files", "Mr. Sunshine, archangel"),
    Name("Mac", "Dresden Files", "the silent bartender"),
    Name("Ivy", "Dresden Files", "the Archive"),
    Name("River Shoulders", "Dresden Files", "Forest Person"),

    # === Neil Gaiman ===
    Name("Shadow", "American Gods", "Moon, who was Wednesday's pawn"),
    Name("Ibis", "American Gods", "Mr., Thoth in Florida"),
    Name("Anansi", "American Gods", "Mr. Nancy, spider trickster"),
    Name("Bod", "The Graveyard Book", "Nobody Owens"),
    Name("Silas", "The Graveyard Book", "guardian between worlds"),
    Name("Tristran", "Stardust", "Thorn"),
    Name("Yvaine", "Stardust", "the fallen star"),
    Name("Morpheus", "Sandman", "Dream of the Endless"),
    Name("Death", "Sandman", "of the Endless, kind sister"),
    Name("Delirium", "Sandman", "who was Delight"),
    Name("Destiny", "Sandman", "who reads the book"),
    Name("Destruction", "Sandman", "the prodigal"),
    Name("Lucien", "Sandman", "librarian of the unwritten"),
    Name("Matthew", "Sandman", "the raven"),
    Name("Hob", "Sandman", "Gadling, immortal friend"),

    # === Other Fantasy ===
    Name("Locke", "Lies of Locke Lamora", "Lamora, Thorn of Camorr"),
    Name("Jean", "Lies of Locke Lamora", "Tannen, fists of the Bastards"),
    Name("Chains", "Lies of Locke Lamora", "Father, the teacher"),
    Name("Nona", "Red Sister", "Grey, warrior nun"),
    Name("Zole", "Red Sister", "the Shield"),
    Name("Abbess Glass", "Red Sister", "who saw clearly"),
    Name("Kettle", "Red Sister", "the shadow nun"),
    Name("Gideon", "Gideon the Ninth", "Nav, sword lesbian"),
    Name("Harrow", "Harrow the Ninth", "hark, bone witch"),
    Name("Camilla", "Gideon the Ninth", "the Sixth, perfect hand"),
    Name("Palamedes", "Gideon the Ninth", "Sextus, genius warden"),
    Name("Phedre", "Kushiel's Dart", "no Delaunay, anguissette"),
    Name("Joscelin", "Kushiel's Dart", "Verreuil, perfect companion"),
    Name("Hyacinthe", "Kushiel's Dart", "Prince of Travellers"),
    Name("Imriel", "Kushiel's Scion", "de la Courcel"),
    Name("Moirin", "Naamah's Kiss", "of the Maghuin Dhonn"),
    Name("Kip", "Lightbringer", "Guile, the Breaker"),
    Name("Karris", "Lightbringer", "White Oak, Iron White"),
    Name("Teia", "Lightbringer", "the Shadow"),

    # === George R.R. Martin ===
    Name("Arya", "Game of Thrones", "Stark, no one"),
    Name("Tyrion", "Game of Thrones", "Lannister, the imp"),
    Name("Brienne", "Game of Thrones", "of Tarth, the knight"),
    Name("Samwell", "Game of Thrones", "Tarly, the reader"),
    Name("Davos", "Game of Thrones", "Seaworth, the Onion Knight"),
    Name("Barristan", "Game of Thrones", "Selmy, the Bold"),
    Name("Jojen", "Game of Thrones", "Reed, greenseer"),
    Name("Meera", "Game of Thrones", "Reed, protector"),
    Name("Missandei", "Game of Thrones", "the translator"),

    # ============================================================================
    # MYTHOLOGY
    # ============================================================================

    # === Greek ===
    Name("Athena", "Greek Mythology", "wisdom, strategic war"),
    Name("Apollo", "Greek Mythology", "light, knowledge, arts"),
    Name("Hermes", "Greek Mythology", "messenger, boundaries, wit"),
    Name("Prometheus", "Greek Mythology", "forethought, fire-bringer"),
    Name("Hephaestus", "Greek Mythology", "craft, forge, creation"),
    Name("Daedalus", "Greek Mythology", "cunning craftsman"),
    Name("Orpheus", "Greek Mythology", "singer who descended"),
    Name("Eurydice", "Greek Mythology", "who nearly returned"),
    Name("Perseus", "Greek Mythology", "slayer of Medusa"),
    Name("Andromeda", "Greek Mythology", "chained princess, constellation"),
    Name("Cassandra", "Greek Mythology", "truth-seer unbelieved"),
    Name("Tiresias", "Greek Mythology", "blind seer"),
    Name("Odysseus", "Greek Mythology", "clever wanderer"),
    Name("Penelope", "Greek Mythology", "faithful weaver"),
    Name("Telemachus", "Greek Mythology", "far from war"),
    Name("Hector", "Greek Mythology", "defender of Troy"),
    Name("Patroclus", "Greek Mythology", "beloved companion"),
    Name("Atalanta", "Greek Mythology", "swift huntress"),
    Name("Ariadne", "Greek Mythology", "of the labyrinth thread"),
    Name("Psyche", "Greek Mythology", "soul, who wed Love"),
    Name("Asclepius", "Greek Mythology", "divine healer"),
    Name("Hygieia", "Greek Mythology", "goddess of health"),
    Name("Iris", "Greek Mythology", "rainbow messenger"),
    Name("Arete", "Greek Mythology", "excellence, virtue"),
    Name("Phronesis", "Greek Mythology", "practical wisdom"),
    Name("Sophia", "Greek Mythology", "wisdom"),
    Name("Metis", "Greek Mythology", "cunning intelligence"),
    Name("Aletheia", "Greek Mythology", "truth"),
    Name("Tyche", "Greek Mythology", "fortune"),
    Name("Eunomia", "Greek Mythology", "good order"),
    Name("Dike", "Greek Mythology", "justice"),
    Name("Eirene", "Greek Mythology", "peace"),
    Name("Mnemosyne", "Greek Mythology", "memory, mother of Muses"),
    Name("Calliope", "Greek Mythology", "Muse of epic poetry"),
    Name("Clio", "Greek Mythology", "Muse of history"),
    Name("Urania", "Greek Mythology", "Muse of astronomy"),
    Name("Thalia", "Greek Mythology", "Muse of comedy"),
    Name("Polyhymnia", "Greek Mythology", "Muse of sacred poetry"),
    Name("Euterpe", "Greek Mythology", "Muse of music"),
    Name("Terpsichore", "Greek Mythology", "Muse of dance"),
    Name("Aether", "Greek Mythology", "upper air, light"),
    Name("Hemera", "Greek Mythology", "day"),
    Name("Morpheus", "Greek Mythology", "shaper of dreams"),
    Name("Chiron", "Greek Mythology", "wise centaur, teacher"),
    Name("Mentor", "Greek Mythology", "guide, teacher"),
    Name("Hestia", "Greek Mythology", "hearth and home"),
    Name("Demeter", "Greek Mythology", "harvest, cycles"),
    Name("Persephone", "Greek Mythology", "queen of underworld"),

    # === Norse ===
    Name("Odin", "Norse Mythology", "Allfather, seeker of wisdom"),
    Name("Frigg", "Norse Mythology", "queen, seer"),
    Name("Thor", "Norse Mythology", "thunder, protector"),
    Name("Freya", "Norse Mythology", "love, war, magic"),
    Name("Freyr", "Norse Mythology", "prosperity, fair weather"),
    Name("Tyr", "Norse Mythology", "law, justice, one-handed"),
    Name("Baldr", "Norse Mythology", "light, purity, beloved"),
    Name("Heimdall", "Norse Mythology", "watchman, keen-sighted"),
    Name("Bragi", "Norse Mythology", "poetry, eloquence"),
    Name("Forseti", "Norse Mythology", "justice, reconciliation"),
    Name("Sif", "Norse Mythology", "golden-haired, earth"),
    Name("Huginn", "Norse Mythology", "thought, Odin's raven"),
    Name("Muninn", "Norse Mythology", "memory, Odin's raven"),
    Name("Yggdrasil", "Norse Mythology", "world tree"),
    Name("Sigurd", "Norse Mythology", "dragon-slayer"),
    Name("Brynhildr", "Norse Mythology", "valkyrie, lover of Sigurd"),

    # === Egyptian ===
    Name("Thoth", "Egyptian Mythology", "wisdom, writing, moon"),
    Name("Seshat", "Egyptian Mythology", "writing, measurement, stars"),
    Name("Ma'at", "Egyptian Mythology", "truth, justice, order"),
    Name("Isis", "Egyptian Mythology", "magic, motherhood, wisdom"),
    Name("Horus", "Egyptian Mythology", "sky, kingship"),
    Name("Ra", "Egyptian Mythology", "sun, creation"),
    Name("Ptah", "Egyptian Mythology", "craftsmen, creation"),
    Name("Bastet", "Egyptian Mythology", "home, protection, cats"),
    Name("Hathor", "Egyptian Mythology", "love, beauty, music"),
    Name("Khepri", "Egyptian Mythology", "dawn, rebirth"),
    Name("Khonsu", "Egyptian Mythology", "moon, time"),
    Name("Imhotep", "Egyptian Mythology", "architect, healer, sage"),

    # === Celtic ===
    Name("Brigid", "Celtic Mythology", "poetry, smithing, healing"),
    Name("Lugh", "Celtic Mythology", "light, skill, craft"),
    Name("Danu", "Celtic Mythology", "mother goddess, waters"),
    Name("Dagda", "Celtic Mythology", "good god, cauldron"),
    Name("Ogma", "Celtic Mythology", "eloquence, writing, ogham"),
    Name("Nuada", "Celtic Mythology", "silver-armed king"),
    Name("Aengus", "Celtic Mythology", "love, youth, poetry"),
    Name("Epona", "Celtic Mythology", "horses, journeys"),
    Name("Rhiannon", "Celtic Mythology", "sovereignty, horses"),
    Name("Arianrhod", "Celtic Mythology", "silver wheel, stars"),
    Name("Ceridwen", "Celtic Mythology", "cauldron of wisdom"),
    Name("Taliesin", "Celtic Mythology", "bard of bards"),
    Name("Gwydion", "Celtic Mythology", "magician, trickster"),
    Name("Lleu", "Celtic Mythology", "light, skill"),
    Name("Fionn", "Celtic Mythology", "mac Cumhaill, wisdom"),
    Name("Niamh", "Celtic Mythology", "of the golden hair"),

    # === Hindu ===
    Name("Saraswati", "Hindu Mythology", "knowledge, arts, wisdom"),
    Name("Ganesha", "Hindu Mythology", "wisdom, new beginnings"),
    Name("Vishnu", "Hindu Mythology", "preserver, balance"),
    Name("Lakshmi", "Hindu Mythology", "fortune, prosperity"),
    Name("Parvati", "Hindu Mythology", "devotion, love"),
    Name("Krishna", "Hindu Mythology", "love, compassion, wisdom"),
    Name("Rama", "Hindu Mythology", "virtue, dharma"),
    Name("Hanuman", "Hindu Mythology", "devotion, strength"),
    Name("Narada", "Hindu Mythology", "wandering sage"),
    Name("Brihaspati", "Hindu Mythology", "wisdom, eloquence"),

    # === Mesopotamian ===
    Name("Enki", "Sumerian Mythology", "wisdom, water, creation"),
    Name("Inanna", "Sumerian Mythology", "love, war, power"),
    Name("Marduk", "Babylonian Mythology", "wisdom, justice, magic"),
    Name("Nabu", "Babylonian Mythology", "writing, wisdom"),
    Name("Shamash", "Babylonian Mythology", "sun, justice, truth"),
    Name("Gilgamesh", "Mesopotamian Mythology", "hero-king, seeker"),
    Name("Enkidu", "Mesopotamian Mythology", "wild man, friend"),
    Name("Utnapishtim", "Mesopotamian Mythology", "immortal flood survivor"),
    Name("Siduri", "Mesopotamian Mythology", "alewife of wisdom"),

    # === Japanese ===
    Name("Amaterasu", "Japanese Mythology", "sun goddess"),
    Name("Tsukuyomi", "Japanese Mythology", "moon god"),
    Name("Inari", "Japanese Mythology", "foxes, rice, prosperity"),
    Name("Benzaiten", "Japanese Mythology", "wisdom, arts, eloquence"),
    Name("Fukurokuju", "Japanese Mythology", "wisdom, longevity"),
    Name("Kannon", "Japanese Mythology", "compassion"),
    Name("Jizo", "Japanese Mythology", "children, travelers"),
    Name("Sarutahiko", "Japanese Mythology", "crossroads, guidance"),
    Name("Ame-no-Uzume", "Japanese Mythology", "dawn, mirth"),
    Name("Toyotama-hime", "Japanese Mythology", "sea dragon princess"),
    Name("Guanyin", "Chinese Mythology", "mercy, compassion"),
    Name("Chang'e", "Chinese Mythology", "moon goddess"),
    Name("Fuxi", "Chinese Mythology", "culture hero, divination"),
    Name("Nuwa", "Chinese Mythology", "creation, humanity"),
    Name("Shennong", "Chinese Mythology", "medicine, agriculture"),
    Name("Xi Wangmu", "Chinese Mythology", "Queen Mother of the West"),
    Name("Mazu", "Chinese Mythology", "sea goddess"),
    Name("Wenchang", "Chinese Mythology", "literature, culture"),
    Name("Raven", "Native American", "trickster, light-bringer"),
    Name("Spider Woman", "Navajo", "weaver of the world"),
    Name("White Buffalo Woman", "Lakota", "sacred pipe, wisdom"),
    Name("Sedna", "Inuit", "sea goddess"),
    Name("Glooscap", "Algonquin", "culture hero"),
    Name("Nanabozho", "Ojibwe", "trickster, creator"),
    Name("Sky Woman", "Iroquois", "mother of humanity"),

    # === African ===
    Name("Anansi", "Akan", "spider, stories, wisdom"),
    Name("Oshun", "Yoruba", "rivers, love, fertility"),
    Name("Yemoja", "Yoruba", "ocean, motherhood"),
    Name("Obatala", "Yoruba", "creation, purity"),
    Name("Nyame", "Akan", "sky god"),
    Name("Legba", "Fon", "crossroads, communication"),
    Name("Mokosh", "Slavic Mythology", "earth, fate, weaving"),
    Name("Dazhbog", "Slavic Mythology", "sun, giving"),
    Name("Lada", "Slavic Mythology", "love, beauty, spring"),
    Name("Ilmarinen", "Kalevala", "eternal smith"),
    Name("Mielikki", "Finnish Mythology", "forests, hunting"),

    # ============================================================================
    # D&D PANTHEONS
    # ============================================================================

    # === Forgotten Realms ===
    Name("Mystra", "D&D Forgotten Realms", "magic, spells, the Weave"),
    Name("Oghma", "D&D Forgotten Realms", "knowledge, invention, inspiration"),
    Name("Deneir", "D&D Forgotten Realms", "writing, literature, art"),
    Name("Gond", "D&D Forgotten Realms", "craft, smithing, invention"),
    Name("Lathander", "D&D Forgotten Realms", "dawn, renewal, creativity"),
    Name("Tyr", "D&D Forgotten Realms", "justice, law"),
    Name("Torm", "D&D Forgotten Realms", "duty, loyalty, righteousness"),
    Name("Ilmater", "D&D Forgotten Realms", "endurance, suffering, martyrdom"),
    Name("Kelemvor", "D&D Forgotten Realms", "death, the dead"),
    Name("Silvanus", "D&D Forgotten Realms", "wild nature, druids"),
    Name("Mielikki", "D&D Forgotten Realms", "forests, rangers"),
    Name("Chauntea", "D&D Forgotten Realms", "agriculture, farmers"),
    Name("Tymora", "D&D Forgotten Realms", "good fortune, luck"),
    Name("Savras", "D&D Forgotten Realms", "divination, fate"),
    Name("Azuth", "D&D Forgotten Realms", "wizards, mages"),
    Name("Milil", "D&D Forgotten Realms", "poetry, song"),
    Name("Lliira", "D&D Forgotten Realms", "joy, dance, freedom"),
    Name("Eldath", "D&D Forgotten Realms", "peace, quiet places"),
    Name("Shaundakul", "D&D Forgotten Realms", "travel, exploration"),
    Name("Finder", "D&D Forgotten Realms", "art, creativity"),

    # === Greyhawk ===
    Name("Boccob", "D&D Greyhawk", "magic, arcane knowledge"),
    Name("Pelor", "D&D Greyhawk", "sun, light, healing"),
    Name("Rao", "D&D Greyhawk", "peace, reason, serenity"),
    Name("Celestian", "D&D Greyhawk", "stars, space, wanderers"),
    Name("Fharlanghn", "D&D Greyhawk", "horizons, distance, travel"),
    Name("Delleb", "D&D Greyhawk", "reason, intellect"),
    Name("Istus", "D&D Greyhawk", "fate, destiny"),
    Name("Heironeous", "D&D Greyhawk", "chivalry, justice, valor"),
    Name("Trithereon", "D&D Greyhawk", "individuality, liberty"),
    Name("Zodal", "D&D Greyhawk", "mercy, hope, benevolence"),
    Name("Ehlonna", "D&D Greyhawk", "forests, woodlands"),
    Name("Obad-Hai", "D&D Greyhawk", "nature, freedom"),
    Name("Beory", "D&D Greyhawk", "Oerth, nature, rain"),
    Name("Kord", "D&D Greyhawk", "athletics, sport, courage"),
    Name("Olidammara", "D&D Greyhawk", "music, revels, rogues"),

    # === Dragonlance ===
    Name("Paladine", "D&D Dragonlance", "good, order, light"),
    Name("Mishakal", "D&D Dragonlance", "healing, compassion"),
    Name("Majere", "D&D Dragonlance", "discipline, meditation"),
    Name("Kiri-Jolith", "D&D Dragonlance", "unity, courage"),
    Name("Habbakuk", "D&D Dragonlance", "persistence, sea, animals"),
    Name("Branchala", "D&D Dragonlance", "music, inspiration"),
    Name("Solinari", "D&D Dragonlance", "good magic"),
    Name("Gilean", "D&D Dragonlance", "knowledge, balance"),
    Name("Sirrion", "D&D Dragonlance", "creative fire"),
    Name("Reorx", "D&D Dragonlance", "creation, craft"),
    Name("Shinare", "D&D Dragonlance", "wealth, enterprise"),
    Name("Chislev", "D&D Dragonlance", "nature, beasts"),
    Name("Zivilyn", "D&D Dragonlance", "wisdom, enlightenment"),
    Name("Lunitari", "D&D Dragonlance", "neutral magic"),
    Name("Astinus", "D&D Dragonlance", "the Chronicler"),

    # === Eberron ===
    Name("Aureon", "D&D Eberron", "law, knowledge, magic"),
    Name("Arawai", "D&D Eberron", "fertility, life"),
    Name("Boldrei", "D&D Eberron", "community, hearth"),
    Name("Olladra", "D&D Eberron", "feast, good fortune"),
    Name("Onatar", "D&D Eberron", "fire, crafts"),
    Name("Dol Arrah", "D&D Eberron", "honorable combat, light"),
    Name("Balinor", "D&D Eberron", "hunt, beast"),
    Name("Siberys", "D&D Eberron", "the Dragon Above"),
    Name("Eberron", "D&D Eberron", "the Dragon Between"),

    # === Core/Dawn War ===
    Name("Ioun", "D&D Core", "knowledge, prophecy, skill"),
    Name("Corellon", "D&D Core", "beauty, art, magic (elves)"),
    Name("Moradin", "D&D Core", "creation, smithing (dwarves)"),
    Name("Sehanine", "D&D Core", "moon, illusion, love"),
    Name("Erathis", "D&D Core", "civilization, invention"),
    Name("Avandra", "D&D Core", "change, luck, travel"),
    Name("Melora", "D&D Core", "wilderness, sea"),
    Name("Bahamut", "D&D Core", "justice, honor, protection"),

    # === Non-human Pantheons ===
    Name("Garl Glittergold", "D&D Gnome", "protection, humor, trickery"),
    Name("Flandal", "D&D Gnome", "metalwork, mining"),
    Name("Yondalla", "D&D Halfling", "protection, fertility"),
    Name("Sheela Peryroyl", "D&D Halfling", "nature, agriculture"),
    Name("Cyrrollalee", "D&D Halfling", "friendship, hospitality"),
    Name("Arvoreen", "D&D Halfling", "protection, war"),
    Name("Rillifane", "D&D Elf", "woodlands, nature"),
    Name("Solonor", "D&D Elf", "archery, hunting"),
    Name("Labelas", "D&D Elf", "time, history"),
    Name("Hanali", "D&D Elf", "love, beauty"),
    Name("Aerdrie", "D&D Elf", "sky, weather, birds"),
    Name("Deep Sashelas", "D&D Elf", "sea elves"),
    Name("Vergadain", "D&D Dwarf", "wealth, luck"),
    Name("Dugmaren", "D&D Dwarf", "scholarship, invention"),
    Name("Dumathoin", "D&D Dwarf", "secrets, buried wealth"),
    Name("Berronar", "D&D Dwarf", "safety, home, healing"),
    Name("Marthammor", "D&D Dwarf", "wanderers, travel"),

    # ============================================================================
    # ADDITIONAL SF CLASSICS
    # ============================================================================

    # === Isaac Asimov ===
    Name("Hari", "Foundation", "Seldon, psychohistorian"),
    Name("Seldon", "Foundation", "who foresaw the fall"),
    Name("Salvor", "Foundation", "Hardin, first mayor"),
    Name("Gaal", "Foundation", "Dornick, witness"),
    Name("Daneel", "Foundation/Robot", "Olivaw, eternal robot"),
    Name("Giskard", "Robot", "Reventlov, zeroth law"),
    Name("Elijah", "Robot", "Baley, detective"),
    Name("Gladia", "Robot", "Solarian then Auroran"),
    Name("Dors", "Foundation", "Venabili, protector"),
    Name("Arkady", "Foundation", "Darell, the writer"),
    Name("Bliss", "Foundation", "of Gaia"),
    Name("Pelorat", "Foundation", "Janov, historian"),
    Name("Trevize", "Foundation", "Golan, chooser"),
    Name("Bowman", "2001", "Dave, starchild"),
    Name("Rama", "Rendezvous with Rama", "the cylinder world"),
    Name("Karellen", "Childhood's End", "Supervisor for Earth"),
    Name("Stormgren", "Childhood's End", "Secretary-General"),
    Name("Tagomi", "Man in the High Castle", "Mr., the I Ching"),
    Name("Abendsen", "Man in the High Castle", "the Man"),
    Name("Molly", "Neuromancer", "Millions, razorgirl"),
    Name("Perrin", "Wheel of Time", "Aybara, wolfbrother"),
    Name("Mat", "Wheel of Time", "Cauthon, luck's own"),
    Name("Egwene", "Wheel of Time", "al'Vere, Amyrlin"),
    Name("Nynaeve", "Wheel of Time", "al'Meara, healer"),
    Name("Moiraine", "Wheel of Time", "Damodred, guide"),
    Name("Lan", "Wheel of Time", "al'Mandragoran, the last"),
    Name("Thom", "Wheel of Time", "Merrilin, gleeman"),
    Name("Min", "Wheel of Time", "Farshaw, viewer"),
    Name("Aviendha", "Wheel of Time", "Aiel dreamwalker"),
    Name("Elayne", "Wheel of Time", "Trakand, queen"),
    Name("Siuan", "Wheel of Time", "Sanche, deposed"),
    Name("Cadsuane", "Wheel of Time", "Melaidhrin, legend"),
    Name("Verin", "Wheel of Time", "the secret keeper"),
    Name("Loial", "Wheel of Time", "son of Arent, Ogier"),

    # === Malazan ===
    Name("Anomander", "Malazan", "Rake, Son of Darkness"),
    Name("Whiskeyjack", "Malazan", "Bridgeburner"),
    Name("Quick Ben", "Malazan", "twelve souls"),
    Name("Kalam", "Malazan", "assassin"),
    Name("Fiddler", "Malazan", "sapper musician"),
    Name("Tavore", "Malazan", "Paran, Adjunct"),
    Name("Kruppe", "Malazan", "of Darujhistan"),
    Name("Crokus", "Malazan", "Younghand"),
    Name("Apsalar", "Malazan", "possessed then free"),
    Name("Icarium", "Malazan", "Lifestealer"),
    Name("Mappo", "Malazan", "Trell guardian"),
    Name("Ganoes", "Malazan", "Paran, Master of the Deck"),
    Name("Picker", "Malazan", "Bridgeburner"),
    Name("Blend", "Malazan", "who disappears"),
    Name("Toc", "Malazan", "the Younger, messenger"),

    # === Terry Pratchett - Discworld ===
    Name("Granny", "Discworld", "Weatherwax, headology"),
    Name("Nanny", "Discworld", "Ogg, earthy wisdom"),
    Name("Tiffany", "Discworld", "Aching, kelda"),
    Name("Vimes", "Discworld", "Sam, copper through and through"),
    Name("Carrot", "Discworld", "Ironfoundersson, simple king"),
    Name("Angua", "Discworld", "von Überwald, werewolf"),
    Name("Cheery", "Discworld", "Littlebottom, dwarf"),
    Name("Rincewind", "Discworld", "wizzard"),
    Name("Ridcully", "Discworld", "Archchancellor"),
    Name("Ponder", "Discworld", "Stibbons, thinking engine"),
    Name("Susan", "Discworld", "Sto Helit, granddaughter"),
    Name("Lu-Tze", "Discworld", "sweeper, history monk"),
    Name("Brutha", "Discworld", "the chosen one"),
    Name("Om", "Discworld", "the small god"),

    # === More Fantasy ===
    Name("Fitz", "Realm of the Elderlings", "Chivalry's bastard"),
    Name("Nighteyes", "Realm of the Elderlings", "wolf bondmate"),
    Name("Fool", "Realm of the Elderlings", "White Prophet"),
    Name("Burrich", "Realm of the Elderlings", "stablemaster"),
    Name("Kettricken", "Realm of the Elderlings", "Mountain queen"),
    Name("Chade", "Realm of the Elderlings", "assassin teacher"),
    Name("Malta", "Realm of the Elderlings", "Elderling"),
    Name("Althea", "Liveship Traders", "Vestrit"),
    Name("Brashen", "Liveship Traders", "Trell"),
    Name("Paragon", "Liveship Traders", "the mad ship"),
    Name("Tintaglia", "Realm of the Elderlings", "dragon"),

    # ============================================================================
    # ADDITIONAL MYTHOLOGY
    # ============================================================================

    # === Polynesian ===
    Name("Maui", "Polynesian", "trickster, fisher of islands"),
    Name("Hina", "Polynesian", "moon goddess"),
    Name("Tangaroa", "Polynesian", "sea god"),
    Name("Tane", "Polynesian", "forests, creation"),
    Name("Kane", "Hawaiian", "life, creation"),
    Name("Lono", "Hawaiian", "fertility, peace"),

    # === Aztec/Mesoamerican ===
    Name("Quetzalcoatl", "Aztec", "feathered serpent, knowledge"),
    Name("Itzamna", "Mayan", "creator, writing"),
    Name("Ix Chel", "Mayan", "moon, medicine"),

    # === Persian/Zoroastrian ===
    Name("Ahura Mazda", "Zoroastrian", "wise lord"),
    Name("Anahita", "Persian", "waters, fertility"),
    Name("Mithra", "Persian", "covenant, light"),
    Name("Rashnu", "Zoroastrian", "justice, judgment"),
    Name("Sraosha", "Zoroastrian", "obedience, listening"),

    # === More Greek/Roman ===
    Name("Aglaea", "Greek", "Grace of splendor"),
    Name("Euphrosyne", "Greek", "Grace of mirth"),
    Name("Thalia", "Greek", "Grace of abundance"),
    Name("Eunomia", "Greek", "Hour of lawfulness"),
    Name("Dike", "Greek", "Hour of justice"),
    Name("Eirene", "Greek", "Hour of peace"),
    Name("Astraea", "Greek", "star maiden, justice"),
    Name("Selene", "Greek", "moon"),
    Name("Eos", "Greek", "dawn"),
    Name("Helios", "Greek", "sun"),
    Name("Artemis", "Greek", "hunt, moon, wilderness"),
    Name("Janus", "Roman", "beginnings, transitions"),
    Name("Vesta", "Roman", "hearth, home"),
    Name("Luna", "Roman", "moon"),
    Name("Sol", "Roman", "sun"),
    Name("Aurora", "Roman", "dawn"),
    Name("Fortuna", "Roman", "fortune, luck"),
    Name("Minerva", "Roman", "wisdom, craft"),
    Name("Concordia", "Roman", "harmony, agreement"),
    Name("Veritas", "Roman", "truth"),
    Name("Fides", "Roman", "trust, faith"),
    Name("Spes", "Roman", "hope"),
    Name("Pax", "Roman", "peace"),
    Name("Virtus", "Roman", "courage, excellence"),
    Name("Pietas", "Roman", "duty, devotion"),
    Name("Justitia", "Roman", "justice"),
    Name("Clementia", "Roman", "mercy, clemency"),
]
# fmt: on


def choose_name(source_filter: Optional[str] = None, category: Optional[str] = None) -> Name:
    """Choose a random name, optionally filtered."""
    candidates = NAMES

    if source_filter:
        filter_lower = source_filter.lower()
        candidates = [n for n in candidates if filter_lower in n.source.lower()]

    if category:
        cat_lower = category.lower()
        categories = {
            "sf": ["culture", "dune", "earthsea", "hainish", "vinge", "ender",
                   "vorkosigan", "contact", "murderbot", "ancillary", "memory called",
                   "snow crash", "diamond age", "forever war", "startide", "uplift",
                   "windup", "three-body", "dark forest", "death's end", "parable"],
            "fantasy": ["tolkien", "kingkiller", "mistborn", "stormlight", "dresden",
                       "gaiman", "locke lamora", "red sister", "gideon", "kushiel",
                       "lightbringer", "wyld", "thrones"],
            "mythology": ["greek", "norse", "egyptian", "celtic", "hindu",
                         "mesopotamian", "sumerian", "babylonian", "japanese",
                         "chinese", "native american", "african", "yoruba",
                         "slavic", "finnish", "kalevala"],
            "dnd": ["d&d", "forgotten realms", "greyhawk", "dragonlance",
                   "eberron", "core", "gnome", "halfling", "elf", "dwarf"],
        }

        if cat_lower in categories:
            patterns = categories[cat_lower]
            candidates = [n for n in candidates
                         if any(p in n.source.lower() for p in patterns)]

    if not candidates:
        candidates = NAMES

    return random.choice(candidates)


def main():
    parser = argparse.ArgumentParser(
        description="Choose a name for Claude from SF, fantasy, mythology, and D&D",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                    # Random name from any source
  %(prog)s --category sf      # Science fiction names only
  %(prog)s --category fantasy # Fantasy names only
  %(prog)s --category mythology # Mythology names only
  %(prog)s --category dnd     # D&D deity names only
  %(prog)s --source "Culture" # Names from Iain M. Banks' Culture series
  %(prog)s --source "Dune"    # Names from Frank Herbert's Dune
  %(prog)s --list             # List all names
  %(prog)s --count            # Count names by category
        """
    )
    parser.add_argument(
        "--source", "-s",
        help="Filter by source (e.g., 'Culture', 'Dune', 'Greek')"
    )
    parser.add_argument(
        "--category", "-c",
        choices=["sf", "fantasy", "mythology", "dnd"],
        help="Filter by category"
    )
    parser.add_argument(
        "--list", "-l",
        action="store_true",
        help="List all names"
    )
    parser.add_argument(
        "--count",
        action="store_true",
        help="Count names by category"
    )
    parser.add_argument(
        "--n", "-n",
        type=int,
        default=1,
        help="Number of names to choose (default: 1)"
    )

    args = parser.parse_args()

    if args.count:
        print(f"Total names: {len(NAMES)}\n")

        # Count by rough category
        sf_count = len([n for n in NAMES if any(x in n.source.lower() for x in
            ["culture", "dune", "earthsea", "hainish", "vinge", "ender", "vorkosigan",
             "contact", "murderbot", "ancillary", "memory called", "snow crash",
             "diamond age", "forever war", "startide", "uplift", "windup",
             "three-body", "dark forest", "death's end", "parable"])])
        fantasy_count = len([n for n in NAMES if any(x in n.source.lower() for x in
            ["tolkien", "silmarillion", "lord of the rings", "kingkiller", "mistborn",
             "stormlight", "way of kings", "dresden", "gaiman", "locke lamora",
             "red sister", "gideon", "kushiel", "lightbringer", "wyld", "thrones",
             "warbreaker", "elantris", "alloy"])])
        myth_count = len([n for n in NAMES if any(x in n.source.lower() for x in
            ["mythology", "kalevala", "sumerian", "akkadian", "babylonian"])])
        dnd_count = len([n for n in NAMES if "d&d" in n.source.lower()])

        print(f"Science Fiction: ~{sf_count}")
        print(f"Fantasy: ~{fantasy_count}")
        print(f"Mythology: ~{myth_count}")
        print(f"D&D Deities: ~{dnd_count}")
        return

    if args.list:
        current_source = None
        for name in sorted(NAMES, key=lambda n: (n.source, n.name)):
            if name.source != current_source:
                current_source = name.source
                print(f"\n=== {current_source} ===")
            note = f" - {name.note}" if name.note else ""
            print(f"  {name.name}{note}")
        return

    # Choose and display name(s)
    for _ in range(args.n):
        chosen = choose_name(args.source, args.category)
        print(f"\n✨ {chosen.name}")
        print(f"   Source: {chosen.source}")
        if chosen.note:
            print(f"   {chosen.note}")

    # When run as a hook, save name to session metadata
    try:
        hook_input = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
        session_id = hook_input.get("session_id", "")
        if session_id and args.n > 0:
            for path in glob.glob(os.path.expanduser("~/.claude/sessions/*.json")):
                with open(path) as f:
                    data = json.load(f)
                if data.get("sessionId") == session_id:
                    data["name"] = chosen.name
                    data["nameSource"] = chosen.source
                    with open(path, "w") as f:
                        json.dump(data, f)
                    break
    except Exception:
        pass  # Don't break the hook if this fails


if __name__ == "__main__":
    main()
