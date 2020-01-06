const puppeteer = require("puppeteer");
const http = require("http");
const child_process = require("child_process");
const fs = require("fs");
const util = require("util");
require("es6-promise").polyfill();
require("isomorphic-fetch");
var nodeinkscape = require("node-inkscape");
var SVGCleaner = require("svg-cleaner").createCleaner;
var arr = [];

var pageno = 0;
function ucfirst(str) {
  if(typeof str != "string") str = String(str);
  return str.substring(0, 1).toUpperCase() + str.substring(1);
}
function map2obj(map) {
  return Object.fromEntries([...map.entries()]);
}
function getFocusedNode(page, rootNode = null) {
  return new Promise(async function(resolve, reject) {
    const snapshot = await page.accessibility.snapshot(rootNode ? { root: rootNode } : undefined);
    const node = findNode(snapshot, node => node.focused);
    return resolve(node);
    function findNode(node, pred = node => node.focused) {
      if(pred(node)) return node;
      for(const child of node.children || []) {
        const foundNode = findNode(child, pred);
        if(foundNode !== null) return foundNode;
      }
      return null;
    }
  }).catch(err => {
    throw err;
  });
}
function range(start, end) {
  return Array.from({ length: end - start + 1 }, (v, k) => k + start);
}

function isoDate(date = new Date()) {
  try {
    const minOffset = date.getTimezoneOffset();
    const milliseconds = date.valueOf() - minOffset * 60 * 1000;
    date = new Date(milliseconds);
    return date
      .toISOString()
      .replace(/T([0-9][0-9]):([0-9][0-9]):([0-9][0-9]).*/, "T$1$2$3")
      .replace(/-/g, "")
      .replace(/T/, "-");
  } catch(err) {}
  return null;
}

function execProg(cmd) {
  console.log("Execute: " + cmd);
  return new Promise((resolve, reject) => {
    child_process.exec(cmd, (error, stdout, stderr) => {
      if(error) reject();
      resolve(stdout);
    });
  });
}
function camelize(text, sep = "") {
  return text.replace(/^([A-Z])|[\s-_]+(\w)/g, function(match, p1, p2, offset) {
    if(p2) return sep + p2.toUpperCase();
    return p1.toLowerCase();
  });
}

const escapeSingleQuoted = str => str.replace(/'/g, "'\\''");
const singleQuoted = str => `'${escapeSingleQuoted(str)}'`;

function pdfInfo(filename) {
  return new Promise((resolve, reject) => {
    execProg(`pdfinfo ${singleQuoted(filename)}`).then(out => {
      resolve(
        out
          ? out.split(/\n/g).reduce((acc, line) => {
              let arr = line.split(/:\s+/);
              const key = camelize(arr[0].replace(/\s+/, "_"));
              if(key) acc[key] = arr[1];
              return acc;
            }, {})
          : null
      );
    });
  });
}

async function pdfToSVG(filename, page, plain = false) {
  let out = filename.replace(/\.pdf$/, "");
  if(page >= 0) out += "-" + page;
  out += ".svg";
  const pageSpec = page >= 0 ? ` --pdf-page=${page}` : "";
  const plainSpec = plain ? " --export-plain-svg" : "";

  let ret = await execProg(
    `inkscape-1.0 --without-gui ${pageSpec}${plainSpec} -o ${singleQuoted(out)} ${singleQuoted(filename)}`
  );
  return out;
}

function svgOptimize(filename) {
  return execProg(
    `svgo --indent=2 --pretty --enable={cleanupAttrs,cleanupEnableBackground,cleanupListOfValues,cleanupNumericValues,convertShapeToPath,convertTransform,inlineStyles,mergePaths,prefixIds,removeComments,removeDesc,removeDoctype,removeEditorsNSData,removeEmptyAttrs,removeEmptyContainers,removeEmptyText,removeHiddenElems,removeMetadata,removeNonInheritableGroupAttrs,removeScriptElement,removeUnknownsAndDefaults,removeUnusedNS,removeUselessDefs,removeUselessStrokeAndFill,removeXMLProcInst,reusePaths,convertPathData,sortAttrs} -i ${singleQuoted(
      filename
    )}`
  );
}

function downloadFile(url, outputFile) {
  const base = (outputFile || String(url).replace(/.*\//g, "")).replace(/\?.*/, "").replace(/\.[a-z]*$/, "");
  let filename = `${base}-${isoDate()}.pdf`;
  const file = fs.openSync(filename, "w+", 0644);
  return new Promise((resolve, reject) => {
    const request = fetch(url).then(res => {
      const { status, headers, body, size, ok, bodyUsed } = res;
      // console.log("res: ", { status, headers, body, size, ok, bodyUsed });
      const buffer = res.buffer();
      buffer.then(data => {
        //   console.log("data: ", data);
        fs.writeSync(file, data);
        fs.closeSync(file);
        resolve(filename);
      });
    });
  });
}

class PostalAddress {
  firstName = "";
  lastName = "";
  additionalAddressInfo = "";
  street = "";
  zip = "";
  city = "";
  country = "";
  phoneNo = "";
  vatNo = "";
  static fields = [
    "firstName",
    "lastName",
    "additionalAddressInfo",
    "street",
    "zip",
    "city",
    "country",
    "phoneNo",
    "vatNo"
  ];
  constructor(props) {
    for(let field of this.constructor.fields) {
      if(props[field]) this[field] = props[field];
    }
  }
  fillFields = (baseStr = "waybill.receiver", page = null, config) => {
    const fieldNames = this.constructor.fields;
    const addressObj = this;
    return (async function(page) {
      if(!/waybill/.test(baseStr)) baseStr = "waybill." + baseStr;
      for(let field of fieldNames) {
        if(/country/i.test(field)) continue;
        let base = /[Cc]ountry/.test(field)
          ? `[data-ng-model="${baseStr.replace(/waybill\./, "") + ucfirst(field)}"]`
          : `input[data-ng-model="${baseStr}.${field}"]`;
        const value = addressObj[field];
        if(value === null || value == "" || !value) continue;
        console.log(`${base} = "${value}"`);
        await page.focus(base);
        await page.waitFor(config.stepDelay);
        await page.keyboard.type(value, { delay: config.keyDelay });
        await page.waitFor(config.stepDelay);
      }
    })(page);
  };
}

(async () => {
  const browser = await puppeteer.launch({ headless: false, defaultViewport: { width: 794, height: 1123 } });

  /**
   * Prepare POST.ch Waybill
   *
   * @param      {Object}   data                                 The data
   * @param      {Object}   [config={stepDelay:75, keyDelay:5}]  The configuration
   * @return     {Promise}
   */
  const prepareWayBill = async (data, config = { stepDelay: 75, keyDelay: 5 }) => {
    const { stepDelay, keyDelay } = config;
    const { receiver, sender, count, weightPerDisc } = data;
    const weight = count * weightPerDisc;

    const page = await browser.newPage();
    const typeOpts = { delay: 100 };
    await page.goto(
      "https://www.post.ch/de/pakete-versenden/deklarieren-und-verzollen/begleitpapiere-international?shortcut=ead&lang=de"
    );

    await page.waitForSelector("#consent_prompt_submit");

    await page.click("#consent_prompt_submit");

    await page.waitForSelector("#id-2a7d8492-6fd7-4f0c-9feb-e2be64f6e2e9-trigger");
    await page.click("#id-2a7d8492-6fd7-4f0c-9feb-e2be64f6e2e9-trigger");
    await page.waitForSelector('a[href*="lang=de&service=frachtbrief"]');
    await page.click('a[href*="lang=de&service=frachtbrief"]');
    await page.waitForNavigation();

    function fillField(name, value) {
      let selector = /(\[|^#)/.test(name) ? name : `input[data-ng-model="${name}"]`;
      let clear = !/^select/.test(selector);
      value = typeof value == "string" ? value : value.toString();
      //console.log("fillField ", { selector, value });
      return new Promise(async function(resolve, reject) {
        let before = await getFocusedNode(page);
        await page.focus(selector);
        await page.waitFor(stepDelay);
        let after = await getFocusedNode(page);
        if(clear) await page.keyboard.press("Backspace");
        await page.keyboard.type(value, { delay: keyDelay });
        await page.waitFor(stepDelay);
        resolve();
      }).catch(err => {
        console.log(`ERROR fillField(${selector}): `, err);
      });
    }

    /**************************************************************************\
  |* Page 1                                                                 *|
  \**************************************************************************/

    const selects = await page.$$("select");

    /*console.log("select ", await (await selects)[0].select("234"));
    console.log("select ", await (await selects)[1].select("1"));
    */
    await fillField('select[data-ng-model="waybill.receiver.countryIso"]', receiver.country);
    await fillField('select[data-ng-model="waybill.weightLevel"]', Math.ceil(weight));

    await page.waitForSelector("#radio-product-7072");
    await page.focus("#radio-product-7072");
    await page.click("#radio-product-7072");

    await fillField("waybill.sender.email", "piroska.scheurer@outlook.com");

    await fillField("waybill.note", "XXX");

    await page.screenshot({ path: `screenshot-${++pageno}.png` });

    await page.click("#button-next");
    await page.waitForNavigation();

    /**************************************************************************\
  |* Page 2                                                                 *|
  \**************************************************************************/

    await page.waitForSelector("#check-content-2");
    await page.focus("#check-content-2");
    await page.click("#check-content-2");

    await fillField("article.quantity", count);

    await fillField("article.description", "Schallplatten");
    await fillField('select[data-ng-model="article.countryIso"]', "Schweiz");

    await fillField("input[weight-field]", (count * 160) / 1000);
    await fillField("input[currency-field]", count * 3.2);

    await page.screenshot({ path: `screenshot-${++pageno}.png` });

    await page.click("#button-next");
    await page.waitForNavigation();

    /**************************************************************************\
  |* Page 3                                                                 *|
  \**************************************************************************/

    await page.waitForSelector('input[data-ng-model="waybill.receiver.firstName"]');

    await receiver.fillFields("receiver", page, config);
    await sender.fillFields("sender", page, config);

    await page.screenshot({ path: `screenshot-${++pageno}.png` });

    await page.click("#button-next");
    await page.waitForNavigation();

    /**************************************************************************\
  |* Page 3                                                                 *|
  \**************************************************************************/

    await page.screenshot({ path: `screenshot-${++pageno}.png` });

    await page.click("#button-next");
    await page.waitForNavigation();

    /**************************************************************************\
  |* Page 4                                                                 *|
  \**************************************************************************/
    await page.waitForSelector("#button-print");

    await page.screenshot({ path: `screenshot-${++pageno}.png` });

    const [popup] = await Promise.all([
      new Promise(resolve => page.once("popup", resolve)),
      page.click("#button-print")
    ]);
    const url = await popup.url();

    //  await browser.close();

    const filename = await downloadFile(url);
    console.log(`downloadFile(${url}) = `, filename);

    const info = await pdfInfo(filename);
    console.log(`pdfInfo(${filename}) = `, info);

    if(info && info.pages) {
      const pages = parseInt(info.pages);

      var files = [];
      arr = [];

      let promises = range(1, pages).map(async i => {
        const svgFile = await pdfToSVG(filename, i);
        const output = await svgOptimize(svgFile);
        console.log("svgo output:", output);
        files.push(await svgFile);
        return output;
      });

      await Promise.all(promises);
      files.forEach(p => {
        console.log("load path:", p);
        loadAndPush(p);
      });

      await createPrintPage();
    }
  };

  function loadAndPush(file) {
    var mySVGCleaner = new SVGCleaner();
    let input = fs.readFileSync(file).toString();
    var svg = mySVGCleaner.load(input);
    let output = svg
      .clean()
      .shortenIDs()
      .removeComments()
      .svgString();
    console.log("opening:", file, (output.length * 100) / input.length);

    arr.push(output);
  }
  async function createPage(url, data = "") {
    const context = await browser.defaultBrowserContext();
    const page = await context.newPage();
    if(data) {
      let buf = Buffer.from(data);
      let encodedData = buf.toString("base64");
      url = "data:text/html;charset=UTF-8;base64," + encodedData;
    }
    if(url) await page.goto(url);
    return await page;
  }

  // prettier-ignore
  const countriesDE = {0: "Deutschland", 1: "Frankreich", 2: "Italien", 3: "Österreich", 4: "USA", 5: "Afghanistan", 6: "Albanien", 7: "Algerien", 8: "Amerikanische Jungferninseln", 9: "Amerikanische Überseeinseln, kleinere", 10: "Andorra", 11: "Angola", 12: "Anguilla", 13: "Antarktis", 14: "Antigua und Barbuda", 15: "Argentinien", 16: "Armenien", 17: "Aruba", 18: "Aserbaidschan", 19: "Australien", 20: "Bahamas", 21: "Bahrain", 22: "Bangladesh", 23: "Barbados", 24: "Belarus", 25: "Belgien", 26: "Belize", 27: "Benin", 28: "Bermuda", 29: "Bhutan", 30: "Bolivien", 31: "Bosnien-Herzegowina", 32: "Botswana", 33: "Bouvet-Insel", 34: "Brasilien", 35: "Britisches Territorium im indischen Ozean", 36: "Brunei", 37: "Bulgarien", 38: "Burkina Faso", 39: "Burundi", 40: "Cayman", 41: "Chile", 42: "China (Volksrepublik)", 43: "Cook-Inseln", 44: "Costa Rica", 45: "Curaçao", 46: "Djibouti", 47: "Dominica", 48: "Dominikanische Republik", 49: "Dänemark", 50: "Ekuador", 51: "El Salvador", 52: "Elfenbeinküste", 53: "Eritrea", 54: "Estland", 55: "Eswatini", 56: "Falkland-Inseln", 57: "Fidschi", 58: "Finnland", 59: "Französisch-Guyana", 60: "Französisch-Polynesien", 61: "Färöer-Inseln", 62: "Gabun", 63: "Gambia", 64: "Georgien", 65: "Ghana", 66: "Gibraltar", 67: "Grenada", 68: "Griechenland", 69: "Grossbritannien", 70: "Grönland", 71: "Guadeloupe", 72: "Guam", 73: "Guatemala", 74: "Guernsey", 75: "Guinea (Republik)", 76: "Guinea-Bissau", 77: "Guyana", 78: "Haiti", 79: "Heard- und McDonald-Inseln", 80: "Honduras", 81: "Hongkong", 82: "Indien", 83: "Indonesien", 84: "Irak", 85: "Iran", 86: "Irland", 87: "Island", 88: "Israel", 89: "Jamaika", 90: "Japan", 91: "Jemen", 92: "Jersey", 93: "Jordanien", 94: "Kambodscha", 95: "Kamerun", 96: "Kanada", 97: "Kapverdische Inseln", 98: "Kasachstan", 99: "Kenia", 100: "Kirgisistan", 101: "Kiribati", 102: "Kokos-Insel (Keeling)", 103: "Kolumbien", 104: "Komoren", 105: "Kongo (Republik)", 106: "Kongo, demokratische Republik", 107: "Korea, Republik (Südkorea)", 108: "Korea, demokratische Volksrepublik (Nordkorea)", 109: "Kosovo", 110: "Kroatien", 111: "Kuba", 112: "Kuwait", 113: "Laos", 114: "Lesotho", 115: "Lettland", 116: "Libanon", 117: "Liberia", 118: "Libyen", 119: "Litauen", 120: "Luxemburg", 121: "Macao", 122: "Madagaskar", 123: "Malawi", 124: "Malaysia", 125: "Malediven", 126: "Mali", 127: "Malta", 128: "Man, Insel", 129: "Marianen-Inseln", 130: "Marokko", 131: "Marshall-Inseln", 132: "Martinique", 133: "Mauretanien", 134: "Mauritius, Insel", 135: "Mayotte", 136: "Mexiko", 137: "Mikronesien (Föderierte Staaten von)", 138: "Moldova", 139: "Monaco", 140: "Mongolei", 141: "Montenegro, Republik", 142: "Montserrat", 143: "Mosambik", 144: "Myanmar (Union)", 145: "Namibia", 146: "Nauru", 147: "Nepal", 148: "Neukaledonien", 149: "Neuseeland", 150: "Nicaragua", 151: "Niederlande", 152: "Niger", 153: "Nigeria", 154: "Niue", 155: "Nordmazedonien", 156: "Norfolk-Insel", 157: "Norwegen", 158: "Oman", 159: "Pakistan", 160: "Palau", 161: "Palästina", 162: "Panama", 163: "Papua-Neuguinea", 164: "Paraguay", 165: "Peru", 166: "Philippinen", 167: "Pitcairn", 168: "Polen", 169: "Portugal", 170: "Puerto Rico", 171: "Qatar", 172: "Rumänien", 173: "Russische Föderation", 174: "Rwanda", 175: "Réunion", 176: "Salomon-Inseln", 177: "Sambia", 178: "Samoa, West", 179: "Samoa, amerikanischer Teil", 180: "San Marino", 181: "Saudi-Arabien", 182: "Schweden", 183: "Senegal", 184: "Serbien, Republik", 185: "Seychellen", 186: "Sierra Leone", 187: "Singapur", 188: "Slowakische Republik", 189: "Slowenien", 190: "Somalia", 191: "Spanien", 192: "Sri Lanka", 193: "St. Barthélemy", 194: "St. Christoph (St. Kitts) und Nevis", 195: "St. Helena, Ascension und Tristan da Cunha", 196: "St. Lucia", 197: "St. Maarten", 198: "St. Martin", 199: "St. Pierre und Miquelon", 200: "St. Thomas und Principe", 201: "St. Vincent und Grenadinen", 202: "Sudan", 203: "Suriname", 204: "Svalbard und Insel Jan Mayen", 205: "Syrien", 206: "Südafrika", 207: "Südgeorgien und die südlichen Sandwichinseln", 208: "Südsudan", 209: "Tadschikistan", 210: "Taiwan (Chinesisches Taipei)", 211: "Tansania", 212: "Thailand", 213: "Timor-Leste", 214: "Togo", 215: "Tokelau", 216: "Tonga", 217: "Trinidad und Tobago", 218: "Tschad", 219: "Tschechische Republik", 220: "Tunesien", 221: "Turkmenistan", 222: "Turks und Caicos", 223: "Tuvalu", 224: "Türkei", 225: "Uganda", 226: "Ukraine", 227: "Ungarn", 228: "Uruguay", 229: "Usbekistan", 230: "Vanuatu", 231: "Vatikan", 232: "Venezuela", 233: "Vereinigte Arabische Emirate", 234: "Vereinigte Staaten von Amerika", 235: "Vietnam", 236: "Virginische Inseln, britischer Teil (Tortola)", 237: "Wallis und Futuna", 238: "Weihnachtsinseln (indischer Ozean)", 239: "Westsahara", 240: "Zentralafrika", 241: "Zimbabwe", 242: "Zypern", 243: "Ägypten", 244: "Äquatorial-Guinea", 245: "Äthiopien"};
  // prettier-ignore
  const countriesEN = {0: "Germany", 1: "France", 2: "Italy", 3: "Austria", 4: "USA", 5: "Afghanistan", 6: "Albania", 7: "Algeria", 8: "American Samoa", 9: "Andorra", 10: "Angola", 11: "Anguilla", 12: "Antarctica", 13: "Antigua and Barbuda", 14: "Argentina", 15: "Armenia", 16: "Aruba", 17: "Australia", 18: "Azerbaijan", 19: "Bahamas", 20: "Bahrain", 21: "Bangladesh", 22: "Barbados", 23: "Belarus", 24: "Belgium", 25: "Belize", 26: "Benin", 27: "Bermuda", 28: "Bhutan", 29: "Bolivia", 30: "Bosnia-Herzegovina", 31: "Botswana", 32: "Bouvet Island", 33: "Brazil", 34: "British Indian Ocean Territory", 35: "Brunei", 36: "Bulgaria", 37: "Burkina Faso", 38: "Burundi", 39: "Cambodia", 40: "Cameroon", 41: "Canada", 42: "Cape Verde", 43: "Cayman Islands", 44: "Central African Republic", 45: "Chad", 46: "Chile", 47: "China (People's Republic OF)", 48: "Christmas Island (Indian Ocean)", 49: "Cocos (Keeling) Island", 50: "Colombia", 51: "Comoros", 52: "Congo (Republic)", 53: "Congo, Democratic Republic", 54: "Cook Islands", 55: "Costa Rica", 56: "Croatia", 57: "Cuba", 58: "Curaçao", 59: "Cyprus", 60: "Czech Republic", 61: "Denmark", 62: "Djibouti", 63: "Dominica", 64: "Dominican Republic", 65: "Ecuador", 66: "Egypt", 67: "El Salvador", 68: "Equatorial Guinea", 69: "Eritrea", 70: "Estonia", 71: "Eswatini", 72: "Ethiopia", 73: "Falkland Islands", 74: "Faroe Islands", 75: "Fiji", 76: "Finland ", 77: "French Guiana", 78: "French Polynesia", 79: "Gabon", 80: "Gambia", 81: "Georgia", 82: "Ghana", 83: "Gibraltar", 84: "Great Britain", 85: "Greece", 86: "Greenland", 87: "Grenada", 88: "Guadeloupe ", 89: "Guam", 90: "Guatemala", 91: "Guernsey", 92: "Guinea (Republic)", 93: "Guinea-Bissau", 94: "Guyana", 95: "Haiti", 96: "Heard AND McDonald Islands", 97: "Honduras", 98: "Hong Kong", 99: "Hungary", 100: "Iceland", 101: "India", 102: "Indonesia", 103: "Iran", 104: "Iraq", 105: "Ireland", 106: "Island OF Man", 107: "Israel", 108: "Ivory Coast", 109: "Jamaica", 110: "Japan", 111: "Jersey", 112: "Jordan", 113: "Kazakhstan", 114: "Kenya", 115: "Kiribati", 116: "Korea, Democratic People's Republic of (North Korea)", 117: "Korea, Republic of (South Korea)", 118: "Kosovo", 119: "Kuwait", 120: "Kyrgyzstan", 121: "Laos", 122: "Latvia", 123: "Lebanon", 124: "Lesotho", 125: "Liberia", 126: "Libya", 127: "Lithuania", 128: "Luxembourg", 129: "Macao", 130: "Madagascar", 131: "Malawi", 132: "Malaysia", 133: "Maldives", 134: "Mali", 135: "Malta", 136: "Mariana Islands", 137: "Marshall Islands", 138: "Martinique", 139: "Mauritania", 140: "Mauritius Island", 141: "Mayotte", 142: "Mexico", 143: "Micronesia (Federated States OF)", 144: "Moldova", 145: "Monaco", 146: "Mongolia", 147: "Montenegro, Republic", 148: "Montserrat", 149: "Morocco", 150: "Mozambique", 151: "Myanmar (Union of)", 152: "Namibia", 153: "Nauru", 154: "Nepal", 155: "Netherlands", 156: "New Caledonia", 157: "New Zealand", 158: "Nicaragua", 159: "Niger", 160: "Nigeria", 161: "Niua", 162: "Norfolk Island", 163: "North Macedonia", 164: "Norway", 165: "Oman", 166: "Pakistan", 167: "Palau", 168: "Palestine", 169: "Panama", 170: "Papua New Guinea", 171: "Paraguay", 172: "Peru", 173: "Philippines", 174: "Pitcairn", 175: "Poland", 176: "Portugal", 177: "Puerto Rico", 178: "Qatar", 179: "Romania", 180: "Russian Federation", 181: "Rwanda", 182: "Réunion", 183: "Salomon Islands", 184: "San Marino", 185: "Saudi Arabia", 186: "Senegal", 187: "Serbia, Republic", 188: "Seychelles", 189: "Sierra Leone", 190: "Singapore", 191: "Slovak Republic", 192: "Slovenia", 193: "Somalia", 194: "South Africa", 195: "South Georgia AND the south Sandwich Islands", 196: "South Sudan", 197: "Spain", 198: "Sri Lanka", 199: "St. Barthélemy", 200: "St. Christopher (St. Kitts) and Nevis", 201: "St. Helena, Ascension and Tristan da Cunha", 202: "St. Lucia", 203: "St. Maarten", 204: "St. Martin", 205: "St. Pierre and Miquelon", 206: "St. Tome and Principe", 207: "St. Vincent and the Grenadines", 208: "Sudan", 209: "Suriname", 210: "Svalbard and Jan Mayen Island", 211: "Sweden", 212: "Syria", 213: "Taiwan (Chinese Taipei)", 214: "Tajikistan", 215: "Tanzania", 216: "Thailand", 217: "Timor-Leste", 218: "Togo", 219: "Tokelau", 220: "Tonga", 221: "Trinidad and Tobago", 222: "Tunisia", 223: "Turkey", 224: "Turkmenistan", 225: "Turks and Caicos", 226: "Tuvalu", 227: "Uganda", 228: "Ukraine", 229: "United Arab Emirates", 230: "United States Minor Outlying Islands", 231: "United States of America", 232: "Uruguay", 233: "Uzbekistan", 234: "Vanuatu", 235: "Vatican City State", 236: "Venezuela", 237: "Vietnam", 238: "Virgin Islands (USA)", 239: "Virgin Islands, British (Tortola)", 240: "Wallis and Futuna Islands", 241: "Western Sahara", 242: "Western Samoa", 243: "Yemen", 244: "Zambia", 245: "Zimbabwe"};
  /*let countries = {};
    for(let key of Object.keys(countriesEN)) {
      key = key;
      countries[key] = {
        en: countriesEN[key],
        de: countriesDE[key]
      };
    }
    console.log(util.inspect(countries).replace(/\s+/g, " "));*/

  const testData = {
    count: 4,
    weightPerDisc: 0.14,
    receiver: new PostalAddress({
      lastName: "Free Software Foundation",
      street: "Schönhauser Allee 6/7",
      // additionalAddressInfo: "Treppenhaus 2, 5. Stock",
      zip: "10119",
      city: "Berlin",
      country: "Deutschland",
      phoneNo: "+49 30 2759 5290"
    }),
    sender: new PostalAddress({
      firstName: "Piroska",
      lastName: "Scheurer",
      street: "Kappelenring 18a",
      zip: "3032",
      city: "Hinterkappelen",
      country: "Schweiz",
      phoneNo: "+41 79 276 01 53"
    })
  };
  /*  ["waybill-20200105-054647-1.svg", "waybill-20200105-054647-2.svg", "waybill-20200105-054647-3.svg", "waybill-20200105-054647-4.svg", "waybill-20200105-054647-5.svg"].forEach(loadAndPush);*/

  async function createPrintPage() {
    const svgDivs = arr.map(str => `<div class="content"><div class="inside">$${str}</div></div>`);
    const domSrc = fs.readFileSync("./lib/dom.es5.js").toString();
    const utilSrc = fs.readFileSync("./lib/util.es5.js").toString();
    const digits = fs.readFileSync("./digits.svg").toString();
    const signature = fs.readFileSync("./unterschrift2.svg").toString();

    const page = await createPage(
      "",
      `<!DOCTYPE html>
      <html>
      <head>
        <style>
          html, body { width: 100vw; margin: 0px; padding: 0px; }
          div#digits { position: fixed; opacity: 0;  }
          div.signature { position: absolute; z-index: 1000;  }
          div.signature > svg { opacity: 0;  }
          div#digits > svg > path {  transform: scale(0.2,0.2); }
          div.container { display: flex; z-index: -1; flex-flow: column nowrap; justify-content: flex-start; align-items: center; width: 100vw; margin: 0 0 60mm 0; }
          div.content { padding: 0; margin: 11mm 5mm 14mm 5mm; overflow: hidden; position: relative; min-width: 192mm; width: 192mm; min-height: 250mm;  height: 250mm; }
          div.inside { position: relative; top: -18.5mm; left: -10.5mm;   min-width: 210mm; width: 210mm; min-height: 297mm;  height: 297mm;  overflow: hidden; }
        </style>
        <script>${utilSrc}</script>
        <script>${domSrc}</script>
      </head>
      <body>
        <div id="digits">${digits}</div>
        <div class="signature">${signature}</div>
        <div class="container">${svgDivs.join("\n")}</div>
      </body>
      </html>`
    );
    var c = console;

    await page.evaluate(c => {
      function getDigit(n) {
        let num = n > 9 ? 10 : n >= 1 ? n - 1 : 9;
        const path = document.querySelectorAll(`div#digits > svg > g > path`)[num];
        const rect = Element.rect(path, { round: false, relative_to: path.ownerSVGElement });
        const { x, y, width, height } = rect;
        const t = new Point(rect.x1, rect.y2).neg();

        const d = path.getAttribute("d");
        return {
          path,
          rect,
          t,
          d,
          toString: function() {
            return `d="${d}" rect=${rect.toSource()} t=${t}`;
          }
        };
      }

      function printDigits(arr, position, parent, scale = 0.32) {
        position = new Point(position);
        for(let digit of arr) {
          const { d, t, path, rect } = getDigit(digit);
          const sw = (Math.random() * 0.6 + 0.3).toFixed(2);
          const color = new HSLA(225, 72, 40, 1).hex();
          let e = SVG.create("path", {
            d,
            class: "digits",
            transform: `  translate(${t.x}, ${t.y}) scale(${scale}, ${scale}) translate(${position.x /
              scale}, ${position.y / scale})  `,
            fill: color,
            stroke: color,
            strokeWidth: sw
          });
          parent.appendChild(e);
          position.x += (digit > 9 ? 10 : 40) * scale;
        }
      }

      /**
       * { function_description }
       *
       * @param      {string}  line    The line
       */
      function debug(line) {
        let found = Element.find("#debug");
        let overlay =
          found ||
          Element.create(
            "div",
            {
              id: "debug",
              style: {
                position: "fixed",
                left: "10px",
                top: "10px",
                width: "50vw",
                height: "100px",
                padding: "4px 4px 4px 4px",
                border: "1px outset hsl(180, 30%, 50%)",
                boxShadow: "-1px -1px  2px 1px black",
                fontFamily: "MiscFixedSC613",
                fontSize: "9",
                backgroundColor: "hsl(180, 91%, 80%)",
                zIndex: "99999",
                borderRadius: "2px",
                overflowX: "hidden",
                overflowY: "scroll",
                transition: "opacity 1s ease-out"
              },
              children: [
                {
                  tagName: "div",
                  margin: "0 0 20px 0",
                  height: "100%",
                  width: "100%",
                  overflow: "auto"
                },
                {
                  tagName: "input",
                  type: "text",
                  length: "100",
                  value: "",
                  style: {
                    position: "relative",
                    width: "100%",
                    border: "0",
                    outline: "none",
                    background: "hsla(0, 0%, 100%, 0.8)"
                  }
                }
              ]
            },
            document.body
          );
        let log = overlay.firstElementChild;
        let input = overlay.lastElementChild;
        const addLine = line => {
          log.innerHTML += "<br />" + line.replace(/\n/g, "<br />");
          overlay.scrollTop = overlay.scrollHeight;
        };
        if(!found) {
          window.debug = debug;
          debug("debug console:");
          input.addEventListener("keydown", event => {
            let e = event.target;
            if(event.keyCode == 13) {
              let result;
              let code = e.value;
              e.value = "";
              try {
                result = window.eval(code);
              } catch(err) {
                result = `ERROR: ${err}`;
              }
              if(result) debug("< " + result);
            }
            // Todo...
          });
          var open = true;
          window.addEventListener("keypress", e => {
            if(e.key == "d") {
              open = !open;
              overlay.style.opacity = open ? 1.0 : 0.0;
              overlay.style.pointerEvents = open ? "all" : "none";
              //  overlay.style.display = open ? "block" : "none";
            }
            // Todo...
          });
        }
        if(line) addLine(line);
      }

      printDigits.rect = Element.rect(Element.find(`div#digits > svg > g`));

      //      printDigits([2, 10, 1, 10, 2, 0, 2, 0], new Point(35 + 4, 43 + 4), document.querySelectorAll("svg")[1]);

      const filled = [...document.querySelectorAll("*[fill]")];
      function getAttrs(e) {
        return e.getAttributeNames().reduce((acc, prop) => {
          acc[prop] = e.getAttribute(prop);
          return acc;
        }, {});
      }
      let fields = filled.filter(
        e =>
          e.getAttribute("fill") != "none" &&
          e.getAttribute("fill") != "#fff" &&
          e.tagName != "tspan" &&
          e.tagName != "text"
      );

      const greyBackgrounds = fields.filter(e => {
        const c = new RGBA(e.getAttribute("fill")).toHSLA();
        return c.l > 10 && c.l < 90 && c.s < 10;
      });

      // debug(greyBackgrounds.length);
      const svgElems = [...document.querySelectorAll("svg")];
      const svgChildren = [...document.querySelectorAll("*")].filter(
        e => !!e.ownerSVGElement && e.tagName != "defs" && e.tagName != "svg"
      );

      //   debug(getDigit(1).toString());

      const textChildren = svgChildren.filter(e => e.tagName == "text" || e.tagName == "tspan" || e.tagName == "path");
      const textRects = textChildren.map(e => Element.rect(e, { round: true, relative_to: document.body }));

      function getElementsAtHeight(x, y, exclude) {
        return textChildren
          .filter(e => {
            let r = Element.rect(e);
            e.rect = r;
            return y >= r.y1 && y <= r.y2;
          })
          .sort((a, b) => b.rect.x - a.rect.x);
      }

      var writeAreas = greyBackgrounds.map(e => {
        let bg = Element.rect(e, { round: true, relative_to: e.ownerSVGElement });
        var childList = textChildren
          .filter(child => e.ownerSVGElement === child.ownerSVGElement)
          .filter(child => {
            let bb = Element.rect(child, { round: true, relative_to: child.ownerSVGElement });
            if(bb.height == 0) {
              bb.height = 3;
              bb.y -= 1.5;
            }
            child.rect = bb;
            return bb.insideRect(bg);
          });
        childList.forEach(child => {
          child.area = e;
          //    borderBox(child, child.ownerSVGElement, child.nextElementSibling, Util.hashString(child.tagName))
        });
        childList.container = e;
        return childList;
      });

      const dateFields = textChildren.filter(e => /^(Date|City...Date)$/i.test(e.innerHTML));

      // debug('dateFields.length:'+dateFields.length);

      dateFields.forEach(e => {
        let r = Element.rect(e, { round: true, relative_to: e.ownerSVGElement });
        let c = r.center;
        let elms = getElementsAtHeight(c.x, r.y + r.width / 2, e);
        c.x += 30;

        if(e.ownerSVGElement) printDigits([2, 10, 1, 10, 2, 0, 2, 0], new Point(c.x + 4, c.y - 5), e.ownerSVGElement);
      });

      const weigthFields = textChildren.filter(e => /^kg$/.test(e.innerHTML));

      weigthFields.forEach(e => {
        let r = Element.rect(e, { round: true, relative_to: e.ownerSVGElement });
        let c = r.center;
        let elms = getElementsAtHeight(c.x, r.y + r.width / 2, e);
        c.x += 30;
        if(e.ownerSVGElement) printDigits([0, 10, 4, 5, 8], new Point(c.x + 4, c.y), e.ownerSVGElement);
      });

      const signatureFields = textChildren.filter(
        e => /(^Signature \/|Signature$)/.test(e.innerHTML) && !/Nom/i.test(e.innerHTML)
      );
      let signaturePositions = [];

      //  debug(signatureFields.length);

      signatureFields.forEach(e => {
        let r = Element.rect(e, { round: true, relative_to: e.ownerSVGElement });
        let ra = Element.rect(e, { round: true });
        let b = Element.rect(e.ownerSVGElement, { round: true });
        let c = r.center;
        let ac = ra.center;
        let elms = getElementsAtHeight(c.x, r.y + r.width / 2, e);
        c.x += 30;
        const color = new HSLA(225, 72, 40, 1).hex();
        const sw = (Math.random() * 0.6 + 0.3).toFixed(2);

        let skip = false;
        let diff = {};

        if(!skip) {
          if(e.ownerSVGElement) {
            signaturePositions.push(new Point(ac));
            let sig = SVG.create("use", {
              href: `#signature-group`,
              fill: color,
              stroke: color,
              strokeWidth: sw,
              transform: `translate(${c.x} ${c.y}) translate(36 -24)`
            });
            e.ownerSVGElement.appendChild(sig);
          }
        }
      });

      /* Remove adjacent duplicates */

      let useList = [...document.querySelectorAll("use")]
        .sort((a, b) => a.getBoundingClientRect().y - b.getBoundingClientRect().y)
        .map(element => ({ element, rect: element.getBoundingClientRect() }));
      let prevRect = new DOMRect(0, 0, 0, 0);
      let prevElement = null;

      useList.forEach(entry => {
        const { element, rect } = entry;
        const yinc = Math.round(rect.y - prevRect.y);
        debug("x: " + Math.round(rect.x) + " y: " + Math.round(rect.y) + " yinc:" + yinc);
        const isTOS = yinc < 500 && prevRect.x < 200;
        const isSecondLine = prevRect.x == rect.x && Math.abs(yinc) < 100;
        if(isSecondLine || isTOS) {
          prevElement.setAttribute("style", "display: none;");
          prevElement.setAttribute("opacity", "0");
          prevElement.setAttribute("fill-opacity", "0");
          prevElement.setAttribute("stroke-opacity", "0");
        }
        if(isTOS) {
          let t = element.getAttribute("transform");
          t += " translate(-36 0)";
          element.setAttribute("transform", t);
        }
        prevRect = rect;
        prevElement = element;
      });

      /*
       textChildren.forEach(e => { const hash = Util.hashString(e.tagName);
       const obj = { text: 15, tspan: 60, path: 115, rect: 160 }; const h =
       obj[e.tagName.toLowerCase()];        if(h === undefined)
       debug(e.tagName); borderBox(e, e.ownerSVGElement, null, h); });
      
       @param      {<type>}  child   The child
       @param      {<type>}  parent  The parent
       @param      {<type>}  before  The before
       @param      {<type>}  hue     The hue
      */
      function borderBox(child, parent, before, hue) {
        let bbox = Element.rect(child, {
          round: true,
          relative_to: child.ownerSVGElement
        });

        if(child.tagName == "path" && bbox.height > 10) bbox.inset(3.5);
        else if(child.tagName[0] == "t") bbox.outset(new TRBL(1, 4, 1, 1));

        if(bbox.height <= 1) {
          bbox.height = 25;
          bbox.y -= bbox.height - 3;
        }
        const { x, y, width, height } = bbox;
        const color = new HSLA(hue, 100, 50, 1).hex();
        let props = { x, y, width, height, fill: "none", stroke: color, strokeWidth: 1.5 };
        if(1) {
          props.strokeLinecap = "round";
          props.strokeDasharray = child.tagName == "path" ? "5 5" : "";
          props.strokeWidth = child.tagName == "path" ? 1.5 : 2;
          props.rx = child.tagName[0] == "t" ? 5 : 0;
          props.ry = child.tagName[0] == "t" ? 5 : 0;
        }
        const r = SVG.create("rect", props);
        if(before) (parent || child.ownerSVGElement).insertBefore(r, before);
        else (parent || child.ownerSVGElement).appendChild(r);
      }

      /* fields.forEach(e => {
        e.setAttribute("fill", "hsla(80, 100%, 80%, 0)");
        borderBox(e, e.parentElement, e.nextElementSibling);
      });*/
    }, console.log);

    //console.log("arr:", arr);
  }
  // await createPrintPage();
  prepareWayBill(testData, { stepDelay: 80, keyDelay: 3 });
})();
