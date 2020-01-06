const fs = require("fs");

  async function createPage(browser, url, data = "") {
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


async function createPrintPages(browser, data, pages) {
  const svgDivs = pages.map(str => `<div class="content"><div class="inside">$${str}</div></div>`);
  const domSrc = fs.readFileSync("./lib/dom.es5.js").toString();
  const utilSrc = fs.readFileSync("./lib/util.es5.js").toString();
  const digits = fs.readFileSync("./digits.svg").toString();
  const signature = fs.readFileSync("./unterschrift2.svg").toString();

  const page = await createPage(browser,
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
        <script>
            var totalWeight = ${data.totalWeight};
        </script>
      </head>
      <body>
        <div id="digits">${digits}</div>
        <div class="signature">${signature}</div>
        <div class="container">${svgDivs.join("\n")}</div>
      </body>
      </html>`
  );
  var c = console;

  await page.evaluate(data => {
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

      let digits = (totalWeight || data.totalWeight)
        .toFixed(3)
        .split("")
        .map(ch => (ch == "." ? 10 : parseInt(ch)));

      if(digits[0] == 10) digits.unshift(0);

      if(e.ownerSVGElement) printDigits(digits, new Point(c.x + 4, c.y), e.ownerSVGElement);
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
  }, data);

  //console.log("arr:", arr);
}

module.exports = createPrintPages;
