const http = require("http");
const fs = require("fs");
const child_process = require("child_process");

require("es6-promise").polyfill();
require("isomorphic-fetch");

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

function downloadFile(url, outputFile) {
  const base = (outputFile || String(url).replace(/.*\//g, "")).replace(/\?.*/, "").replace(/\.[a-z]*$/, "");
  let filename = `${base}-${isoDate()}.pdf`;
  const file = fs.openSync(filename, "w+", 0644);
  return new Promise((resolve, reject) => {
    const request = fetch(url).then(res => {
      const { status, headers, body, size, ok, bodyUsed } = res;
      console.log("res: ", { status, headers, body, size, ok, bodyUsed });
      const buffer = res.buffer();
      buffer.then(data => {
        console.log("data: ", data);
        fs.writeSync(file, data);
        fs.closeSync(file);
        resolve();
      });
    });
  });
}

function execProg(cmd) {
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

function pdfInfo(filename) {
  return new Promise((resolve, reject) => {
    execProg(`pdfinfo '${filename.replace(/'/g, "'\\''")}'`).then(output => {
      resolve(
        output
          ? output.split(/\n/g).reduce((acc, line) => {
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

function waitAll(p) {
  if(!Array.isArray(p)) {
    return Promise.reject(new TypeError("p-wait-all: p must be array"));
  }
  return new Promise(function(c, rej) {
    var ok = 0;
    var e = null;
    var o = [];
    check();
    for(var i = 0; i < p.length; i++)
      (function(p, i) {
        p.then(
          function(r) {
            o[i] = r;
            ok++;
            check();
          },
          function(_err) {
            if(!e) e = _err;
            ok++;
            check();
          }
        );
      })(p[i], i);
    function check() {
      if(ok === p.length) {
        if(e) rej(e);
        else c(o);
      }
    }
  });
}

function rotateLeft(x, n) {
  n = n & 0x1f;
  return (x << n) | ((x >> (32 - n)) & ~((-1 >> n) << n));
}
function rotateRight(x, n) {
  n = n & 0x1f;
  return rotateLeft(x, 32 - n);
}

function hashString(string, bits = 32, mask = 0xffffffff) {
  var ret = 0;
  var bitc = 0;
  for(var i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i);

    ret *= 3;
    ret ^= code;
    bitc += 8;

    ret = rotateLeft(ret, 11) & mask;
    //ret =  ((ret << 8) | ((ret >> (bits - 8)) & 0xff)) & mask;
  }
  return ret & 0x7fffffff;
}

for (let str of ["path", "text", "tspan", "rect"]) {
  console.log(str + ": " + (hashString(str) % 360));
}
(async () => {
  console.log(await pdfInfo("waybill-20200105-023531.pdf"));
})();
//downloadFile("https://apps.post.ch/fb/public/api/waybills/b4807ff8-970a-40c2-b9e3-2ad6edd40c49/waybill.pdf?type=final");
