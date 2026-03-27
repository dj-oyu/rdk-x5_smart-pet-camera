(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  function __accessProp(key) {
    return this[key];
  }
  var __toCommonJS = (from) => {
    var entry = (__moduleCache ??= new WeakMap).get(from), desc;
    if (entry)
      return entry;
    entry = __defProp({}, "__esModule", { value: true });
    if (from && typeof from === "object" || typeof from === "function") {
      for (var key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(entry, key))
          __defProp(entry, key, {
            get: __accessProp.bind(from, key),
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
    }
    __moduleCache.set(from, entry);
    return entry;
  };
  var __moduleCache;
  var __returnValue = (v) => v;
  function __exportSetter(name, newValue) {
    this[name] = __returnValue.bind(null, newValue);
  }
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, {
        get: all[name],
        enumerable: true,
        configurable: true,
        set: __exportSetter.bind(all, name)
      });
  };
  var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);

  // node_modules/preact/dist/preact.module.js
  var exports_preact_module = {};
  __export(exports_preact_module, {
    toChildArray: () => L,
    render: () => J,
    options: () => l,
    isValidElement: () => t,
    hydrate: () => K,
    h: () => _,
    createRef: () => b,
    createElement: () => _,
    createContext: () => R,
    cloneElement: () => Q,
    Fragment: () => k,
    Component: () => x
  });
  function w(n2, l2) {
    for (var u2 in l2)
      n2[u2] = l2[u2];
    return n2;
  }
  function g(n2) {
    n2 && n2.parentNode && n2.parentNode.removeChild(n2);
  }
  function _(l2, u2, t2) {
    var i2, r2, o2, e2 = {};
    for (o2 in u2)
      o2 == "key" ? i2 = u2[o2] : o2 == "ref" ? r2 = u2[o2] : e2[o2] = u2[o2];
    if (arguments.length > 2 && (e2.children = arguments.length > 3 ? n.call(arguments, 2) : t2), typeof l2 == "function" && l2.defaultProps != null)
      for (o2 in l2.defaultProps)
        e2[o2] === undefined && (e2[o2] = l2.defaultProps[o2]);
    return m(l2, e2, i2, r2, null);
  }
  function m(n2, t2, i2, r2, o2) {
    var e2 = { type: n2, props: t2, key: i2, ref: r2, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: undefined, __v: o2 == null ? ++u : o2, __i: -1, __u: 0 };
    return o2 == null && l.vnode != null && l.vnode(e2), e2;
  }
  function b() {
    return { current: null };
  }
  function k(n2) {
    return n2.children;
  }
  function x(n2, l2) {
    this.props = n2, this.context = l2;
  }
  function S(n2, l2) {
    if (l2 == null)
      return n2.__ ? S(n2.__, n2.__i + 1) : null;
    for (var u2;l2 < n2.__k.length; l2++)
      if ((u2 = n2.__k[l2]) != null && u2.__e != null)
        return u2.__e;
    return typeof n2.type == "function" ? S(n2) : null;
  }
  function C(n2) {
    if (n2.__P && n2.__d) {
      var u2 = n2.__v, t2 = u2.__e, i2 = [], r2 = [], o2 = w({}, u2);
      o2.__v = u2.__v + 1, l.vnode && l.vnode(o2), z(n2.__P, o2, u2, n2.__n, n2.__P.namespaceURI, 32 & u2.__u ? [t2] : null, i2, t2 == null ? S(u2) : t2, !!(32 & u2.__u), r2), o2.__v = u2.__v, o2.__.__k[o2.__i] = o2, V(i2, o2, r2), u2.__e = u2.__ = null, o2.__e != t2 && M(o2);
    }
  }
  function M(n2) {
    if ((n2 = n2.__) != null && n2.__c != null)
      return n2.__e = n2.__c.base = null, n2.__k.some(function(l2) {
        if (l2 != null && l2.__e != null)
          return n2.__e = n2.__c.base = l2.__e;
      }), M(n2);
  }
  function $(n2) {
    (!n2.__d && (n2.__d = true) && i.push(n2) && !I.__r++ || r != l.debounceRendering) && ((r = l.debounceRendering) || o)(I);
  }
  function I() {
    try {
      for (var n2, l2 = 1;i.length; )
        i.length > l2 && i.sort(e), n2 = i.shift(), l2 = i.length, C(n2);
    } finally {
      i.length = I.__r = 0;
    }
  }
  function P(n2, l2, u2, t2, i2, r2, o2, e2, f2, c2, s2) {
    var a2, h2, y2, d2, w2, g2, _2, m2 = t2 && t2.__k || v, b2 = l2.length;
    for (f2 = A(u2, l2, m2, f2, b2), a2 = 0;a2 < b2; a2++)
      (y2 = u2.__k[a2]) != null && (h2 = y2.__i != -1 && m2[y2.__i] || p, y2.__i = a2, g2 = z(n2, y2, h2, i2, r2, o2, e2, f2, c2, s2), d2 = y2.__e, y2.ref && h2.ref != y2.ref && (h2.ref && D(h2.ref, null, y2), s2.push(y2.ref, y2.__c || d2, y2)), w2 == null && d2 != null && (w2 = d2), (_2 = !!(4 & y2.__u)) || h2.__k === y2.__k ? f2 = H(y2, f2, n2, _2) : typeof y2.type == "function" && g2 !== undefined ? f2 = g2 : d2 && (f2 = d2.nextSibling), y2.__u &= -7);
    return u2.__e = w2, f2;
  }
  function A(n2, l2, u2, t2, i2) {
    var r2, o2, e2, f2, c2, s2 = u2.length, a2 = s2, h2 = 0;
    for (n2.__k = new Array(i2), r2 = 0;r2 < i2; r2++)
      (o2 = l2[r2]) != null && typeof o2 != "boolean" && typeof o2 != "function" ? (typeof o2 == "string" || typeof o2 == "number" || typeof o2 == "bigint" || o2.constructor == String ? o2 = n2.__k[r2] = m(null, o2, null, null, null) : d(o2) ? o2 = n2.__k[r2] = m(k, { children: o2 }, null, null, null) : o2.constructor === undefined && o2.__b > 0 ? o2 = n2.__k[r2] = m(o2.type, o2.props, o2.key, o2.ref ? o2.ref : null, o2.__v) : n2.__k[r2] = o2, f2 = r2 + h2, o2.__ = n2, o2.__b = n2.__b + 1, e2 = null, (c2 = o2.__i = T(o2, u2, f2, a2)) != -1 && (a2--, (e2 = u2[c2]) && (e2.__u |= 2)), e2 == null || e2.__v == null ? (c2 == -1 && (i2 > s2 ? h2-- : i2 < s2 && h2++), typeof o2.type != "function" && (o2.__u |= 4)) : c2 != f2 && (c2 == f2 - 1 ? h2-- : c2 == f2 + 1 ? h2++ : (c2 > f2 ? h2-- : h2++, o2.__u |= 4))) : n2.__k[r2] = null;
    if (a2)
      for (r2 = 0;r2 < s2; r2++)
        (e2 = u2[r2]) != null && (2 & e2.__u) == 0 && (e2.__e == t2 && (t2 = S(e2)), E(e2, e2));
    return t2;
  }
  function H(n2, l2, u2, t2) {
    var i2, r2;
    if (typeof n2.type == "function") {
      for (i2 = n2.__k, r2 = 0;i2 && r2 < i2.length; r2++)
        i2[r2] && (i2[r2].__ = n2, l2 = H(i2[r2], l2, u2, t2));
      return l2;
    }
    n2.__e != l2 && (t2 && (l2 && n2.type && !l2.parentNode && (l2 = S(n2)), u2.insertBefore(n2.__e, l2 || null)), l2 = n2.__e);
    do {
      l2 = l2 && l2.nextSibling;
    } while (l2 != null && l2.nodeType == 8);
    return l2;
  }
  function L(n2, l2) {
    return l2 = l2 || [], n2 == null || typeof n2 == "boolean" || (d(n2) ? n2.some(function(n3) {
      L(n3, l2);
    }) : l2.push(n2)), l2;
  }
  function T(n2, l2, u2, t2) {
    var i2, r2, o2, e2 = n2.key, f2 = n2.type, c2 = l2[u2], s2 = c2 != null && (2 & c2.__u) == 0;
    if (c2 === null && e2 == null || s2 && e2 == c2.key && f2 == c2.type)
      return u2;
    if (t2 > (s2 ? 1 : 0)) {
      for (i2 = u2 - 1, r2 = u2 + 1;i2 >= 0 || r2 < l2.length; )
        if ((c2 = l2[o2 = i2 >= 0 ? i2-- : r2++]) != null && (2 & c2.__u) == 0 && e2 == c2.key && f2 == c2.type)
          return o2;
    }
    return -1;
  }
  function j(n2, l2, u2) {
    l2[0] == "-" ? n2.setProperty(l2, u2 == null ? "" : u2) : n2[l2] = u2 == null ? "" : typeof u2 != "number" || y.test(l2) ? u2 : u2 + "px";
  }
  function F(n2, l2, u2, t2, i2) {
    var r2, o2;
    n:
      if (l2 == "style")
        if (typeof u2 == "string")
          n2.style.cssText = u2;
        else {
          if (typeof t2 == "string" && (n2.style.cssText = t2 = ""), t2)
            for (l2 in t2)
              u2 && l2 in u2 || j(n2.style, l2, "");
          if (u2)
            for (l2 in u2)
              t2 && u2[l2] == t2[l2] || j(n2.style, l2, u2[l2]);
        }
      else if (l2[0] == "o" && l2[1] == "n")
        r2 = l2 != (l2 = l2.replace(f, "$1")), o2 = l2.toLowerCase(), l2 = o2 in n2 || l2 == "onFocusOut" || l2 == "onFocusIn" ? o2.slice(2) : l2.slice(2), n2.l || (n2.l = {}), n2.l[l2 + r2] = u2, u2 ? t2 ? u2.u = t2.u : (u2.u = c, n2.addEventListener(l2, r2 ? a : s, r2)) : n2.removeEventListener(l2, r2 ? a : s, r2);
      else {
        if (i2 == "http://www.w3.org/2000/svg")
          l2 = l2.replace(/xlink(H|:h)/, "h").replace(/sName$/, "s");
        else if (l2 != "width" && l2 != "height" && l2 != "href" && l2 != "list" && l2 != "form" && l2 != "tabIndex" && l2 != "download" && l2 != "rowSpan" && l2 != "colSpan" && l2 != "role" && l2 != "popover" && l2 in n2)
          try {
            n2[l2] = u2 == null ? "" : u2;
            break n;
          } catch (n3) {}
        typeof u2 == "function" || (u2 == null || u2 === false && l2[4] != "-" ? n2.removeAttribute(l2) : n2.setAttribute(l2, l2 == "popover" && u2 == 1 ? "" : u2));
      }
  }
  function O(n2) {
    return function(u2) {
      if (this.l) {
        var t2 = this.l[u2.type + n2];
        if (u2.t == null)
          u2.t = c++;
        else if (u2.t < t2.u)
          return;
        return t2(l.event ? l.event(u2) : u2);
      }
    };
  }
  function z(n2, u2, t2, i2, r2, o2, e2, f2, c2, s2) {
    var a2, h2, p2, y2, _2, m2, b2, S2, C2, M2, $2, I2, A2, H2, L2, T2 = u2.type;
    if (u2.constructor !== undefined)
      return null;
    128 & t2.__u && (c2 = !!(32 & t2.__u), o2 = [f2 = u2.__e = t2.__e]), (a2 = l.__b) && a2(u2);
    n:
      if (typeof T2 == "function")
        try {
          if (S2 = u2.props, C2 = T2.prototype && T2.prototype.render, M2 = (a2 = T2.contextType) && i2[a2.__c], $2 = a2 ? M2 ? M2.props.value : a2.__ : i2, t2.__c ? b2 = (h2 = u2.__c = t2.__c).__ = h2.__E : (C2 ? u2.__c = h2 = new T2(S2, $2) : (u2.__c = h2 = new x(S2, $2), h2.constructor = T2, h2.render = G), M2 && M2.sub(h2), h2.state || (h2.state = {}), h2.__n = i2, p2 = h2.__d = true, h2.__h = [], h2._sb = []), C2 && h2.__s == null && (h2.__s = h2.state), C2 && T2.getDerivedStateFromProps != null && (h2.__s == h2.state && (h2.__s = w({}, h2.__s)), w(h2.__s, T2.getDerivedStateFromProps(S2, h2.__s))), y2 = h2.props, _2 = h2.state, h2.__v = u2, p2)
            C2 && T2.getDerivedStateFromProps == null && h2.componentWillMount != null && h2.componentWillMount(), C2 && h2.componentDidMount != null && h2.__h.push(h2.componentDidMount);
          else {
            if (C2 && T2.getDerivedStateFromProps == null && S2 !== y2 && h2.componentWillReceiveProps != null && h2.componentWillReceiveProps(S2, $2), u2.__v == t2.__v || !h2.__e && h2.shouldComponentUpdate != null && h2.shouldComponentUpdate(S2, h2.__s, $2) === false) {
              u2.__v != t2.__v && (h2.props = S2, h2.state = h2.__s, h2.__d = false), u2.__e = t2.__e, u2.__k = t2.__k, u2.__k.some(function(n3) {
                n3 && (n3.__ = u2);
              }), v.push.apply(h2.__h, h2._sb), h2._sb = [], h2.__h.length && e2.push(h2);
              break n;
            }
            h2.componentWillUpdate != null && h2.componentWillUpdate(S2, h2.__s, $2), C2 && h2.componentDidUpdate != null && h2.__h.push(function() {
              h2.componentDidUpdate(y2, _2, m2);
            });
          }
          if (h2.context = $2, h2.props = S2, h2.__P = n2, h2.__e = false, I2 = l.__r, A2 = 0, C2)
            h2.state = h2.__s, h2.__d = false, I2 && I2(u2), a2 = h2.render(h2.props, h2.state, h2.context), v.push.apply(h2.__h, h2._sb), h2._sb = [];
          else
            do {
              h2.__d = false, I2 && I2(u2), a2 = h2.render(h2.props, h2.state, h2.context), h2.state = h2.__s;
            } while (h2.__d && ++A2 < 25);
          h2.state = h2.__s, h2.getChildContext != null && (i2 = w(w({}, i2), h2.getChildContext())), C2 && !p2 && h2.getSnapshotBeforeUpdate != null && (m2 = h2.getSnapshotBeforeUpdate(y2, _2)), H2 = a2 != null && a2.type === k && a2.key == null ? q(a2.props.children) : a2, f2 = P(n2, d(H2) ? H2 : [H2], u2, t2, i2, r2, o2, e2, f2, c2, s2), h2.base = u2.__e, u2.__u &= -161, h2.__h.length && e2.push(h2), b2 && (h2.__E = h2.__ = null);
        } catch (n3) {
          if (u2.__v = null, c2 || o2 != null)
            if (n3.then) {
              for (u2.__u |= c2 ? 160 : 128;f2 && f2.nodeType == 8 && f2.nextSibling; )
                f2 = f2.nextSibling;
              o2[o2.indexOf(f2)] = null, u2.__e = f2;
            } else {
              for (L2 = o2.length;L2--; )
                g(o2[L2]);
              N(u2);
            }
          else
            u2.__e = t2.__e, u2.__k = t2.__k, n3.then || N(u2);
          l.__e(n3, u2, t2);
        }
      else
        o2 == null && u2.__v == t2.__v ? (u2.__k = t2.__k, u2.__e = t2.__e) : f2 = u2.__e = B(t2.__e, u2, t2, i2, r2, o2, e2, c2, s2);
    return (a2 = l.diffed) && a2(u2), 128 & u2.__u ? undefined : f2;
  }
  function N(n2) {
    n2 && (n2.__c && (n2.__c.__e = true), n2.__k && n2.__k.some(N));
  }
  function V(n2, u2, t2) {
    for (var i2 = 0;i2 < t2.length; i2++)
      D(t2[i2], t2[++i2], t2[++i2]);
    l.__c && l.__c(u2, n2), n2.some(function(u3) {
      try {
        n2 = u3.__h, u3.__h = [], n2.some(function(n3) {
          n3.call(u3);
        });
      } catch (n3) {
        l.__e(n3, u3.__v);
      }
    });
  }
  function q(n2) {
    return typeof n2 != "object" || n2 == null || n2.__b > 0 ? n2 : d(n2) ? n2.map(q) : w({}, n2);
  }
  function B(u2, t2, i2, r2, o2, e2, f2, c2, s2) {
    var a2, h2, v2, y2, w2, _2, m2, b2 = i2.props || p, k2 = t2.props, x2 = t2.type;
    if (x2 == "svg" ? o2 = "http://www.w3.org/2000/svg" : x2 == "math" ? o2 = "http://www.w3.org/1998/Math/MathML" : o2 || (o2 = "http://www.w3.org/1999/xhtml"), e2 != null) {
      for (a2 = 0;a2 < e2.length; a2++)
        if ((w2 = e2[a2]) && "setAttribute" in w2 == !!x2 && (x2 ? w2.localName == x2 : w2.nodeType == 3)) {
          u2 = w2, e2[a2] = null;
          break;
        }
    }
    if (u2 == null) {
      if (x2 == null)
        return document.createTextNode(k2);
      u2 = document.createElementNS(o2, x2, k2.is && k2), c2 && (l.__m && l.__m(t2, e2), c2 = false), e2 = null;
    }
    if (x2 == null)
      b2 === k2 || c2 && u2.data == k2 || (u2.data = k2);
    else {
      if (e2 = e2 && n.call(u2.childNodes), !c2 && e2 != null)
        for (b2 = {}, a2 = 0;a2 < u2.attributes.length; a2++)
          b2[(w2 = u2.attributes[a2]).name] = w2.value;
      for (a2 in b2)
        w2 = b2[a2], a2 == "dangerouslySetInnerHTML" ? v2 = w2 : a2 == "children" || (a2 in k2) || a2 == "value" && ("defaultValue" in k2) || a2 == "checked" && ("defaultChecked" in k2) || F(u2, a2, null, w2, o2);
      for (a2 in k2)
        w2 = k2[a2], a2 == "children" ? y2 = w2 : a2 == "dangerouslySetInnerHTML" ? h2 = w2 : a2 == "value" ? _2 = w2 : a2 == "checked" ? m2 = w2 : c2 && typeof w2 != "function" || b2[a2] === w2 || F(u2, a2, w2, b2[a2], o2);
      if (h2)
        c2 || v2 && (h2.__html == v2.__html || h2.__html == u2.innerHTML) || (u2.innerHTML = h2.__html), t2.__k = [];
      else if (v2 && (u2.innerHTML = ""), P(t2.type == "template" ? u2.content : u2, d(y2) ? y2 : [y2], t2, i2, r2, x2 == "foreignObject" ? "http://www.w3.org/1999/xhtml" : o2, e2, f2, e2 ? e2[0] : i2.__k && S(i2, 0), c2, s2), e2 != null)
        for (a2 = e2.length;a2--; )
          g(e2[a2]);
      c2 || (a2 = "value", x2 == "progress" && _2 == null ? u2.removeAttribute("value") : _2 != null && (_2 !== u2[a2] || x2 == "progress" && !_2 || x2 == "option" && _2 != b2[a2]) && F(u2, a2, _2, b2[a2], o2), a2 = "checked", m2 != null && m2 != u2[a2] && F(u2, a2, m2, b2[a2], o2));
    }
    return u2;
  }
  function D(n2, u2, t2) {
    try {
      if (typeof n2 == "function") {
        var i2 = typeof n2.__u == "function";
        i2 && n2.__u(), i2 && u2 == null || (n2.__u = n2(u2));
      } else
        n2.current = u2;
    } catch (n3) {
      l.__e(n3, t2);
    }
  }
  function E(n2, u2, t2) {
    var i2, r2;
    if (l.unmount && l.unmount(n2), (i2 = n2.ref) && (i2.current && i2.current != n2.__e || D(i2, null, u2)), (i2 = n2.__c) != null) {
      if (i2.componentWillUnmount)
        try {
          i2.componentWillUnmount();
        } catch (n3) {
          l.__e(n3, u2);
        }
      i2.base = i2.__P = null;
    }
    if (i2 = n2.__k)
      for (r2 = 0;r2 < i2.length; r2++)
        i2[r2] && E(i2[r2], u2, t2 || typeof n2.type != "function");
    t2 || g(n2.__e), n2.__c = n2.__ = n2.__e = undefined;
  }
  function G(n2, l2, u2) {
    return this.constructor(n2, u2);
  }
  function J(u2, t2, i2) {
    var r2, o2, e2, f2;
    t2 == document && (t2 = document.documentElement), l.__ && l.__(u2, t2), o2 = (r2 = typeof i2 == "function") ? null : i2 && i2.__k || t2.__k, e2 = [], f2 = [], z(t2, u2 = (!r2 && i2 || t2).__k = _(k, null, [u2]), o2 || p, p, t2.namespaceURI, !r2 && i2 ? [i2] : o2 ? null : t2.firstChild ? n.call(t2.childNodes) : null, e2, !r2 && i2 ? i2 : o2 ? o2.__e : t2.firstChild, r2, f2), V(e2, u2, f2);
  }
  function K(n2, l2) {
    J(n2, l2, K);
  }
  function Q(l2, u2, t2) {
    var i2, r2, o2, e2, f2 = w({}, l2.props);
    for (o2 in l2.type && l2.type.defaultProps && (e2 = l2.type.defaultProps), u2)
      o2 == "key" ? i2 = u2[o2] : o2 == "ref" ? r2 = u2[o2] : f2[o2] = u2[o2] === undefined && e2 != null ? e2[o2] : u2[o2];
    return arguments.length > 2 && (f2.children = arguments.length > 3 ? n.call(arguments, 2) : t2), m(l2.type, f2, i2 || l2.key, r2 || l2.ref, null);
  }
  function R(n2) {
    function l2(n3) {
      var u2, t2;
      return this.getChildContext || (u2 = new Set, (t2 = {})[l2.__c] = this, this.getChildContext = function() {
        return t2;
      }, this.componentWillUnmount = function() {
        u2 = null;
      }, this.shouldComponentUpdate = function(n4) {
        this.props.value != n4.value && u2.forEach(function(n5) {
          n5.__e = true, $(n5);
        });
      }, this.sub = function(n4) {
        u2.add(n4);
        var l3 = n4.componentWillUnmount;
        n4.componentWillUnmount = function() {
          u2 && u2.delete(n4), l3 && l3.call(n4);
        };
      }), n3.children;
    }
    return l2.__c = "__cC" + h++, l2.__ = n2, l2.Provider = l2.__l = (l2.Consumer = function(n3, l3) {
      return n3.children(l3);
    }).contextType = l2, l2;
  }
  var n, l, u, t, i, r, o, e, f, c, s, a, h, p, v, y, d;
  var init_preact_module = __esm(() => {
    p = {};
    v = [];
    y = /acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i;
    d = Array.isArray;
    n = v.slice, l = { __e: function(n2, l2, u2, t2) {
      for (var i2, r2, o2;l2 = l2.__; )
        if ((i2 = l2.__c) && !i2.__)
          try {
            if ((r2 = i2.constructor) && r2.getDerivedStateFromError != null && (i2.setState(r2.getDerivedStateFromError(n2)), o2 = i2.__d), i2.componentDidCatch != null && (i2.componentDidCatch(n2, t2 || {}), o2 = i2.__d), o2)
              return i2.__E = i2;
          } catch (l3) {
            n2 = l3;
          }
      throw n2;
    } }, u = 0, t = function(n2) {
      return n2 != null && n2.constructor === undefined;
    }, x.prototype.setState = function(n2, l2) {
      var u2;
      u2 = this.__s != null && this.__s != this.state ? this.__s : this.__s = w({}, this.state), typeof n2 == "function" && (n2 = n2(w({}, u2), this.props)), n2 && w(u2, n2), n2 != null && this.__v && (l2 && this._sb.push(l2), $(this));
    }, x.prototype.forceUpdate = function(n2) {
      this.__v && (this.__e = true, n2 && this.__h.push(n2), $(this));
    }, x.prototype.render = k, i = [], o = typeof Promise == "function" ? Promise.prototype.then.bind(Promise.resolve()) : setTimeout, e = function(n2, l2) {
      return n2.__v.__b - l2.__v.__b;
    }, I.__r = 0, f = /(PointerCapture)$|Capture$/i, c = 0, s = O(false), a = O(true), h = 0;
  });

  // node_modules/preact/debug/dist/debug.module.js
  init_preact_module();

  // node_modules/preact/devtools/dist/devtools.module.js
  init_preact_module();
  var i2;
  (i2 = typeof globalThis != "undefined" ? globalThis : typeof window != "undefined" ? window : undefined) != null && i2.__PREACT_DEVTOOLS__ && i2.__PREACT_DEVTOOLS__.attachPreact("10.29.0", l, { Fragment: k, Component: x });

  // node_modules/preact/debug/dist/debug.module.js
  var t2 = {};
  function a2(e2) {
    return e2.type === k ? "Fragment" : typeof e2.type == "function" ? e2.type.displayName || e2.type.name : typeof e2.type == "string" ? e2.type : "#text";
  }
  var i3 = [];
  var s2 = [];
  function c2() {
    return i3.length > 0 ? i3[i3.length - 1] : null;
  }
  var l2 = true;
  function u2(e2) {
    return typeof e2.type == "function" && e2.type != k;
  }
  function f2(n2) {
    for (var e2 = [n2], o2 = n2;o2.__o != null; )
      e2.push(o2.__o), o2 = o2.__o;
    return e2.reduce(function(n3, e3) {
      n3 += "  in " + a2(e3);
      var o3 = e3.__source;
      return o3 ? n3 += " (at " + o3.fileName + ":" + o3.lineNumber + ")" : l2 && console.warn("Add @babel/plugin-transform-react-jsx-source to get a more detailed component stack. Note that you should not add it to production builds of your App for bundle size reasons."), l2 = false, n3 + `
`;
    }, "");
  }
  var d2 = typeof WeakMap == "function";
  function p2(n2) {
    var e2 = [];
    return n2.__k ? (n2.__k.forEach(function(n3) {
      n3 && typeof n3.type == "function" ? e2.push.apply(e2, p2(n3)) : n3 && typeof n3.type == "string" && e2.push(n3.type);
    }), e2) : e2;
  }
  function h2(n2) {
    return n2 ? typeof n2.type == "function" ? n2.__ == null ? n2.__e != null && n2.__e.parentNode != null ? n2.__e.parentNode.localName : "" : h2(n2.__) : n2.type : "";
  }
  var v2 = x.prototype.setState;
  function y2(n2) {
    return n2 === "table" || n2 === "tfoot" || n2 === "tbody" || n2 === "thead" || n2 === "td" || n2 === "tr" || n2 === "th";
  }
  x.prototype.setState = function(n2, e2) {
    return this.__v == null && this.state == null && console.warn(`Calling "this.setState" inside the constructor of a component is a no-op and might be a bug in your application. Instead, set "this.state = {}" directly.

` + f2(c2())), v2.call(this, n2, e2);
  };
  var m2 = /^(address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h1|h2|h3|h4|h5|h6|header|hgroup|hr|main|menu|nav|ol|p|pre|search|section|table|ul)$/;
  var b2 = x.prototype.forceUpdate;
  function w2(n2) {
    var e2 = n2.props, o2 = a2(n2), t3 = "";
    for (var r2 in e2)
      if (e2.hasOwnProperty(r2) && r2 !== "children") {
        var i4 = e2[r2];
        typeof i4 == "function" && (i4 = "function " + (i4.displayName || i4.name) + "() {}"), i4 = Object(i4) !== i4 || i4.toString ? i4 + "" : Object.prototype.toString.call(i4), t3 += " " + r2 + "=" + JSON.stringify(i4);
      }
    var s3 = e2.children;
    return "<" + o2 + t3 + (s3 && s3.length ? ">..</" + o2 + ">" : " />");
  }
  x.prototype.forceUpdate = function(n2) {
    return this.__v == null ? console.warn(`Calling "this.forceUpdate" inside the constructor of a component is a no-op and might be a bug in your application.

` + f2(c2())) : this.__P == null && console.warn(`Can't call "this.forceUpdate" on an unmounted component. This is a no-op, but it indicates a memory leak in your application. To fix, cancel all subscriptions and asynchronous tasks in the componentWillUnmount method.

` + f2(this.__v)), b2.call(this, n2);
  }, l.__m = function(n2, e2) {
    var o2 = n2.type, t3 = e2.map(function(n3) {
      return n3 && n3.localName;
    }).filter(Boolean);
    console.error('Expected a DOM node of type "' + o2 + '" but found "' + t3.join(", ") + `" as available DOM-node(s), this is caused by the SSR'd HTML containing different DOM-nodes compared to the hydrated one.

` + f2(n2));
  }, function() {
    (function() {
      var n3 = l.__b, o3 = l.diffed, t3 = l.__, r3 = l.vnode, a3 = l.__r;
      l.diffed = function(n4) {
        u2(n4) && s2.pop(), i3.pop(), o3 && o3(n4);
      }, l.__b = function(e2) {
        u2(e2) && i3.push(e2), n3 && n3(e2);
      }, l.__ = function(n4, e2) {
        s2 = [], t3 && t3(n4, e2);
      }, l.vnode = function(n4) {
        n4.__o = s2.length > 0 ? s2[s2.length - 1] : null, r3 && r3(n4);
      }, l.__r = function(n4) {
        u2(n4) && s2.push(n4), a3 && a3(n4);
      };
    })();
    var n2 = false, o2 = l.__b, r2 = l.diffed, c3 = l.vnode, l3 = l.__r, v3 = l.__e, b3 = l.__, g2 = l.__h, E2 = d2 ? { useEffect: new WeakMap, useLayoutEffect: new WeakMap, lazyPropTypes: new WeakMap } : null, k2 = [];
    l.__e = function(n3, e2, o3, t3) {
      if (e2 && e2.__c && typeof n3.then == "function") {
        var r3 = n3;
        n3 = new Error("Missing Suspense. The throwing component was: " + a2(e2));
        for (var i4 = e2;i4; i4 = i4.__)
          if (i4.__c && i4.__c.__c) {
            n3 = r3;
            break;
          }
        if (n3 instanceof Error)
          throw n3;
      }
      try {
        (t3 = t3 || {}).componentStack = f2(e2), v3(n3, e2, o3, t3), typeof n3.then != "function" && setTimeout(function() {
          throw n3;
        });
      } catch (n4) {
        throw n4;
      }
    }, l.__ = function(n3, e2) {
      if (!e2)
        throw new Error(`Undefined parent passed to render(), this is the second argument.
Check if the element is available in the DOM/has the correct id.`);
      var o3;
      switch (e2.nodeType) {
        case 1:
        case 11:
        case 9:
          o3 = true;
          break;
        default:
          o3 = false;
      }
      if (!o3) {
        var t3 = a2(n3);
        throw new Error("Expected a valid HTML node as a second argument to render.\tReceived " + e2 + " instead: render(<" + t3 + " />, " + e2 + ");");
      }
      b3 && b3(n3, e2);
    }, l.__b = function(e2) {
      var r3 = e2.type;
      if (n2 = true, r3 === undefined)
        throw new Error(`Undefined component passed to createElement()

You likely forgot to export your component or might have mixed up default and named imports` + w2(e2) + `

` + f2(e2));
      if (r3 != null && typeof r3 == "object") {
        if (r3.__k !== undefined && r3.__e !== undefined)
          throw new Error("Invalid type passed to createElement(): " + r3 + `

Did you accidentally pass a JSX literal as JSX twice?

  let My` + a2(e2) + " = " + w2(r3) + `;
  let vnode = <My` + a2(e2) + ` />;

This usually happens when you export a JSX literal and not the component.

` + f2(e2));
        throw new Error("Invalid type passed to createElement(): " + (Array.isArray(r3) ? "array" : r3));
      }
      if (e2.ref !== undefined && typeof e2.ref != "function" && typeof e2.ref != "object" && !("$$typeof" in e2))
        throw new Error(`Component's "ref" property should be a function, or an object created by createRef(), but got [` + typeof e2.ref + `] instead
` + w2(e2) + `

` + f2(e2));
      if (typeof e2.type == "string") {
        for (var i4 in e2.props)
          if (i4[0] === "o" && i4[1] === "n" && typeof e2.props[i4] != "function" && e2.props[i4] != null)
            throw new Error(`Component's "` + i4 + '" property should be a function, but got [' + typeof e2.props[i4] + `] instead
` + w2(e2) + `

` + f2(e2));
      }
      if (typeof e2.type == "function" && e2.type.propTypes) {
        if (e2.type.displayName === "Lazy" && E2 && !E2.lazyPropTypes.has(e2.type)) {
          var s3 = "PropTypes are not supported on lazy(). Use propTypes on the wrapped component itself. ";
          try {
            var c4 = e2.type();
            E2.lazyPropTypes.set(e2.type, true), console.warn(s3 + "Component wrapped in lazy() is " + a2(c4));
          } catch (n3) {
            console.warn(s3 + "We will log the wrapped component's name once it is loaded.");
          }
        }
        var l4 = e2.props;
        e2.type.__f && delete (l4 = function(n3, e3) {
          for (var o3 in e3)
            n3[o3] = e3[o3];
          return n3;
        }({}, l4)).ref, function(n3, e3, o3, r4, a3) {
          Object.keys(n3).forEach(function(o4) {
            var i5;
            try {
              i5 = n3[o4](e3, o4, r4, "prop", null, "SECRET_DO_NOT_PASS_THIS_OR_YOU_WILL_BE_FIRED");
            } catch (n4) {
              i5 = n4;
            }
            i5 && !(i5.message in t2) && (t2[i5.message] = true, console.error("Failed prop type: " + i5.message + (a3 && `
` + a3() || "")));
          });
        }(e2.type.propTypes, l4, 0, a2(e2), function() {
          return f2(e2);
        });
      }
      o2 && o2(e2);
    };
    var T2, _2 = 0;
    l.__r = function(e2) {
      l3 && l3(e2), n2 = true;
      var o3 = e2.__c;
      if (o3 === T2 ? _2++ : _2 = 1, _2 >= 25)
        throw new Error("Too many re-renders. This is limited to prevent an infinite loop which may lock up your browser. The component causing this is: " + a2(e2));
      T2 = o3;
    }, l.__h = function(e2, o3, t3) {
      if (!e2 || !n2)
        throw new Error("Hook can only be invoked from render methods.");
      g2 && g2(e2, o3, t3);
    };
    var O2 = function(n3, e2) {
      return { get: function() {
        var o3 = "get" + n3 + e2;
        k2 && k2.indexOf(o3) < 0 && (k2.push(o3), console.warn("getting vnode." + n3 + " is deprecated, " + e2));
      }, set: function() {
        var o3 = "set" + n3 + e2;
        k2 && k2.indexOf(o3) < 0 && (k2.push(o3), console.warn("setting vnode." + n3 + " is not allowed, " + e2));
      } };
    }, I2 = { nodeName: O2("nodeName", "use vnode.type"), attributes: O2("attributes", "use vnode.props"), children: O2("children", "use vnode.props.children") }, M2 = Object.create({}, I2);
    l.vnode = function(n3) {
      var e2 = n3.props;
      if (n3.type !== null && e2 != null && (("__source" in e2) || ("__self" in e2))) {
        var o3 = n3.props = {};
        for (var t3 in e2) {
          var r3 = e2[t3];
          t3 === "__source" ? n3.__source = r3 : t3 === "__self" ? n3.__self = r3 : o3[t3] = r3;
        }
      }
      n3.__proto__ = M2, c3 && c3(n3);
    }, l.diffed = function(e2) {
      var o3, t3 = e2.type, i4 = e2.__;
      if (e2.__k && e2.__k.forEach(function(n3) {
        if (typeof n3 == "object" && n3 && n3.type === undefined) {
          var o4 = Object.keys(n3).join(",");
          throw new Error("Objects are not valid as a child. Encountered an object with the keys {" + o4 + `}.

` + f2(e2));
        }
      }), e2.__c === T2 && (_2 = 0), typeof t3 == "string" && (y2(t3) || t3 === "p" || t3 === "a" || t3 === "button")) {
        var s3 = h2(i4);
        if (s3 !== "" && y2(t3))
          t3 === "table" && s3 !== "td" && y2(s3) ? console.error("Improper nesting of table. Your <table> should not have a table-node parent." + w2(e2) + `

` + f2(e2)) : t3 !== "thead" && t3 !== "tfoot" && t3 !== "tbody" || s3 === "table" ? t3 === "tr" && s3 !== "thead" && s3 !== "tfoot" && s3 !== "tbody" ? console.error("Improper nesting of table. Your <tr> should have a <thead/tbody/tfoot> parent." + w2(e2) + `

` + f2(e2)) : t3 === "td" && s3 !== "tr" ? console.error("Improper nesting of table. Your <td> should have a <tr> parent." + w2(e2) + `

` + f2(e2)) : t3 === "th" && s3 !== "tr" && console.error("Improper nesting of table. Your <th> should have a <tr>." + w2(e2) + `

` + f2(e2)) : console.error("Improper nesting of table. Your <thead/tbody/tfoot> should have a <table> parent." + w2(e2) + `

` + f2(e2));
        else if (t3 === "p") {
          var c4 = p2(e2).filter(function(n3) {
            return m2.test(n3);
          });
          c4.length && console.error("Improper nesting of paragraph. Your <p> should not have " + c4.join(", ") + " as child-elements." + w2(e2) + `

` + f2(e2));
        } else
          t3 !== "a" && t3 !== "button" || p2(e2).indexOf(t3) !== -1 && console.error("Improper nesting of interactive content. Your <" + t3 + "> should not have other " + (t3 === "a" ? "anchor" : "button") + " tags as child-elements." + w2(e2) + `

` + f2(e2));
      }
      if (n2 = false, r2 && r2(e2), e2.__k != null)
        for (var l4 = [], u3 = 0;u3 < e2.__k.length; u3++) {
          var d3 = e2.__k[u3];
          if (d3 && d3.key != null) {
            var v4 = d3.key;
            if (l4.indexOf(v4) !== -1) {
              console.error('Following component has two or more children with the same key attribute: "' + v4 + `". This may cause glitches and misbehavior in rendering process. Component: 

` + w2(e2) + `

` + f2(e2));
              break;
            }
            l4.push(v4);
          }
        }
      if (e2.__c != null && e2.__c.__H != null) {
        var b4 = e2.__c.__H.__;
        if (b4)
          for (var g3 = 0;g3 < b4.length; g3 += 1) {
            var E3 = b4[g3];
            if (E3.__H) {
              for (var k3 = 0;k3 < E3.__H.length; k3++)
                if ((o3 = E3.__H[k3]) != o3) {
                  var O3 = a2(e2);
                  console.warn("Invalid argument passed to hook. Hooks should not be called with NaN in the dependency array. Hook index " + g3 + " in component " + O3 + " was called with NaN.");
                }
            }
          }
      }
    };
  }();

  // src/signals-test.tsx
  init_preact_module();

  // node_modules/preact/hooks/dist/hooks.module.js
  init_preact_module();
  var t3;
  var r2;
  var u3;
  var i4;
  var o2 = 0;
  var f3 = [];
  var c3 = l;
  var e2 = c3.__b;
  var a3 = c3.__r;
  var v3 = c3.diffed;
  var l3 = c3.__c;
  var m3 = c3.unmount;
  var s3 = c3.__;
  function p3(n2, t4) {
    c3.__h && c3.__h(r2, n2, o2 || t4), o2 = 0;
    var u4 = r2.__H || (r2.__H = { __: [], __h: [] });
    return n2 >= u4.__.length && u4.__.push({}), u4.__[n2];
  }
  function d3(n2) {
    return o2 = 1, h3(D2, n2);
  }
  function h3(n2, u4, i5) {
    var o3 = p3(t3++, 2);
    if (o3.t = n2, !o3.__c && (o3.__ = [i5 ? i5(u4) : D2(undefined, u4), function(n3) {
      var t4 = o3.__N ? o3.__N[0] : o3.__[0], r3 = o3.t(t4, n3);
      t4 !== r3 && (o3.__N = [r3, o3.__[1]], o3.__c.setState({}));
    }], o3.__c = r2, !r2.__f)) {
      var f4 = function(n3, t4, r3) {
        if (!o3.__c.__H)
          return true;
        var u5 = o3.__c.__H.__.filter(function(n4) {
          return n4.__c;
        });
        if (u5.every(function(n4) {
          return !n4.__N;
        }))
          return !c4 || c4.call(this, n3, t4, r3);
        var i6 = o3.__c.props !== n3;
        return u5.some(function(n4) {
          if (n4.__N) {
            var t5 = n4.__[0];
            n4.__ = n4.__N, n4.__N = undefined, t5 !== n4.__[0] && (i6 = true);
          }
        }), c4 && c4.call(this, n3, t4, r3) || i6;
      };
      r2.__f = true;
      var { shouldComponentUpdate: c4, componentWillUpdate: e3 } = r2;
      r2.componentWillUpdate = function(n3, t4, r3) {
        if (this.__e) {
          var u5 = c4;
          c4 = undefined, f4(n3, t4, r3), c4 = u5;
        }
        e3 && e3.call(this, n3, t4, r3);
      }, r2.shouldComponentUpdate = f4;
    }
    return o3.__N || o3.__;
  }
  function y3(n2, u4) {
    var i5 = p3(t3++, 3);
    !c3.__s && C2(i5.__H, u4) && (i5.__ = n2, i5.u = u4, r2.__H.__h.push(i5));
  }
  function A2(n2) {
    return o2 = 5, T2(function() {
      return { current: n2 };
    }, []);
  }
  function T2(n2, r3) {
    var u4 = p3(t3++, 7);
    return C2(u4.__H, r3) && (u4.__ = n2(), u4.__H = r3, u4.__h = n2), u4.__;
  }
  function j2() {
    for (var n2;n2 = f3.shift(); ) {
      var t4 = n2.__H;
      if (n2.__P && t4)
        try {
          t4.__h.some(z2), t4.__h.some(B2), t4.__h = [];
        } catch (r3) {
          t4.__h = [], c3.__e(r3, n2.__v);
        }
    }
  }
  c3.__b = function(n2) {
    r2 = null, e2 && e2(n2);
  }, c3.__ = function(n2, t4) {
    n2 && t4.__k && t4.__k.__m && (n2.__m = t4.__k.__m), s3 && s3(n2, t4);
  }, c3.__r = function(n2) {
    a3 && a3(n2), t3 = 0;
    var i5 = (r2 = n2.__c).__H;
    i5 && (u3 === r2 ? (i5.__h = [], r2.__h = [], i5.__.some(function(n3) {
      n3.__N && (n3.__ = n3.__N), n3.u = n3.__N = undefined;
    })) : (i5.__h.some(z2), i5.__h.some(B2), i5.__h = [], t3 = 0)), u3 = r2;
  }, c3.diffed = function(n2) {
    v3 && v3(n2);
    var t4 = n2.__c;
    t4 && t4.__H && (t4.__H.__h.length && (f3.push(t4) !== 1 && i4 === c3.requestAnimationFrame || ((i4 = c3.requestAnimationFrame) || w3)(j2)), t4.__H.__.some(function(n3) {
      n3.u && (n3.__H = n3.u), n3.u = undefined;
    })), u3 = r2 = null;
  }, c3.__c = function(n2, t4) {
    t4.some(function(n3) {
      try {
        n3.__h.some(z2), n3.__h = n3.__h.filter(function(n4) {
          return !n4.__ || B2(n4);
        });
      } catch (r3) {
        t4.some(function(n4) {
          n4.__h && (n4.__h = []);
        }), t4 = [], c3.__e(r3, n3.__v);
      }
    }), l3 && l3(n2, t4);
  }, c3.unmount = function(n2) {
    m3 && m3(n2);
    var t4, r3 = n2.__c;
    r3 && r3.__H && (r3.__H.__.some(function(n3) {
      try {
        z2(n3);
      } catch (n4) {
        t4 = n4;
      }
    }), r3.__H = undefined, t4 && c3.__e(t4, r3.__v));
  };
  var k2 = typeof requestAnimationFrame == "function";
  function w3(n2) {
    var t4, r3 = function() {
      clearTimeout(u4), k2 && cancelAnimationFrame(t4), setTimeout(n2);
    }, u4 = setTimeout(r3, 35);
    k2 && (t4 = requestAnimationFrame(r3));
  }
  function z2(n2) {
    var t4 = r2, u4 = n2.__c;
    typeof u4 == "function" && (n2.__c = undefined, u4()), r2 = t4;
  }
  function B2(n2) {
    var t4 = r2;
    n2.__c = n2.__(), r2 = t4;
  }
  function C2(n2, t4) {
    return !n2 || n2.length !== t4.length || t4.some(function(t5, r3) {
      return t5 !== n2[r3];
    });
  }
  function D2(n2, t4) {
    return typeof t4 == "function" ? t4(n2) : t4;
  }

  // node_modules/@preact/signals/dist/signals.module.js
  init_preact_module();

  // node_modules/@preact/signals-core/dist/signals-core.module.js
  var i5 = Symbol.for("preact-signals");
  function t4() {
    if (!(s4 > 1)) {
      var i6, t5 = false;
      (function() {
        var i7 = d4;
        d4 = undefined;
        while (i7 !== undefined) {
          if (i7.S.v === i7.v)
            i7.S.i = i7.i;
          i7 = i7.o;
        }
      })();
      while (h4 !== undefined) {
        var n2 = h4;
        h4 = undefined;
        v4++;
        while (n2 !== undefined) {
          var r3 = n2.u;
          n2.u = undefined;
          n2.f &= -3;
          if (!(8 & n2.f) && w4(n2))
            try {
              n2.c();
            } catch (n3) {
              if (!t5) {
                i6 = n3;
                t5 = true;
              }
            }
          n2 = r3;
        }
      }
      v4 = 0;
      s4--;
      if (t5)
        throw i6;
    } else
      s4--;
  }
  function n2(i6) {
    if (s4 > 0)
      return i6();
    e3 = ++u4;
    s4++;
    try {
      return i6();
    } finally {
      t4();
    }
  }
  var r3 = undefined;
  function o3(i6) {
    var t5 = r3;
    r3 = undefined;
    try {
      return i6();
    } finally {
      r3 = t5;
    }
  }
  var f4;
  var h4 = undefined;
  var s4 = 0;
  var v4 = 0;
  var u4 = 0;
  var e3 = 0;
  var d4 = undefined;
  var c4 = 0;
  function a4(i6) {
    if (r3 !== undefined) {
      var t5 = i6.n;
      if (t5 === undefined || t5.t !== r3) {
        t5 = { i: 0, S: i6, p: r3.s, n: undefined, t: r3, e: undefined, x: undefined, r: t5 };
        if (r3.s !== undefined)
          r3.s.n = t5;
        r3.s = t5;
        i6.n = t5;
        if (32 & r3.f)
          i6.S(t5);
        return t5;
      } else if (t5.i === -1) {
        t5.i = 0;
        if (t5.n !== undefined) {
          t5.n.p = t5.p;
          if (t5.p !== undefined)
            t5.p.n = t5.n;
          t5.p = r3.s;
          t5.n = undefined;
          r3.s.n = t5;
          r3.s = t5;
        }
        return t5;
      }
    }
  }
  function l4(i6, t5) {
    this.v = i6;
    this.i = 0;
    this.n = undefined;
    this.t = undefined;
    this.l = 0;
    this.W = t5 == null ? undefined : t5.watched;
    this.Z = t5 == null ? undefined : t5.unwatched;
    this.name = t5 == null ? undefined : t5.name;
  }
  l4.prototype.brand = i5;
  l4.prototype.h = function() {
    return true;
  };
  l4.prototype.S = function(i6) {
    var t5 = this, n3 = this.t;
    if (n3 !== i6 && i6.e === undefined) {
      i6.x = n3;
      this.t = i6;
      if (n3 !== undefined)
        n3.e = i6;
      else
        o3(function() {
          var i7;
          (i7 = t5.W) == null || i7.call(t5);
        });
    }
  };
  l4.prototype.U = function(i6) {
    var t5 = this;
    if (this.t !== undefined) {
      var { e: n3, x: r4 } = i6;
      if (n3 !== undefined) {
        n3.x = r4;
        i6.e = undefined;
      }
      if (r4 !== undefined) {
        r4.e = n3;
        i6.x = undefined;
      }
      if (i6 === this.t) {
        this.t = r4;
        if (r4 === undefined)
          o3(function() {
            var i7;
            (i7 = t5.Z) == null || i7.call(t5);
          });
      }
    }
  };
  l4.prototype.subscribe = function(i6) {
    var t5 = this;
    return C3(function() {
      var n3 = t5.value, o4 = r3;
      r3 = undefined;
      try {
        i6(n3);
      } finally {
        r3 = o4;
      }
    }, { name: "sub" });
  };
  l4.prototype.valueOf = function() {
    return this.value;
  };
  l4.prototype.toString = function() {
    return this.value + "";
  };
  l4.prototype.toJSON = function() {
    return this.value;
  };
  l4.prototype.peek = function() {
    var i6 = r3;
    r3 = undefined;
    try {
      return this.value;
    } finally {
      r3 = i6;
    }
  };
  Object.defineProperty(l4.prototype, "value", { get: function() {
    var i6 = a4(this);
    if (i6 !== undefined)
      i6.i = this.i;
    return this.v;
  }, set: function(i6) {
    if (i6 !== this.v) {
      if (v4 > 100)
        throw new Error("Cycle detected");
      (function(i7) {
        if (s4 !== 0 && v4 === 0) {
          if (i7.l !== e3) {
            i7.l = e3;
            d4 = { S: i7, v: i7.v, i: i7.i, o: d4 };
          }
        }
      })(this);
      this.v = i6;
      this.i++;
      c4++;
      s4++;
      try {
        for (var n3 = this.t;n3 !== undefined; n3 = n3.x)
          n3.t.N();
      } finally {
        t4();
      }
    }
  } });
  function y4(i6, t5) {
    return new l4(i6, t5);
  }
  function w4(i6) {
    for (var t5 = i6.s;t5 !== undefined; t5 = t5.n)
      if (t5.S.i !== t5.i || !t5.S.h() || t5.S.i !== t5.i)
        return true;
    return false;
  }
  function _2(i6) {
    for (var t5 = i6.s;t5 !== undefined; t5 = t5.n) {
      var n3 = t5.S.n;
      if (n3 !== undefined)
        t5.r = n3;
      t5.S.n = t5;
      t5.i = -1;
      if (t5.n === undefined) {
        i6.s = t5;
        break;
      }
    }
  }
  function b3(i6) {
    var t5 = i6.s, n3 = undefined;
    while (t5 !== undefined) {
      var r4 = t5.p;
      if (t5.i === -1) {
        t5.S.U(t5);
        if (r4 !== undefined)
          r4.n = t5.n;
        if (t5.n !== undefined)
          t5.n.p = r4;
      } else
        n3 = t5;
      t5.S.n = t5.r;
      if (t5.r !== undefined)
        t5.r = undefined;
      t5 = r4;
    }
    i6.s = n3;
  }
  function p4(i6, t5) {
    l4.call(this, undefined);
    this.x = i6;
    this.s = undefined;
    this.g = c4 - 1;
    this.f = 4;
    this.W = t5 == null ? undefined : t5.watched;
    this.Z = t5 == null ? undefined : t5.unwatched;
    this.name = t5 == null ? undefined : t5.name;
  }
  p4.prototype = new l4;
  p4.prototype.h = function() {
    this.f &= -3;
    if (1 & this.f)
      return false;
    if ((36 & this.f) == 32)
      return true;
    this.f &= -5;
    if (this.g === c4)
      return true;
    this.g = c4;
    this.f |= 1;
    if (this.i > 0 && !w4(this)) {
      this.f &= -2;
      return true;
    }
    var i6 = r3;
    try {
      _2(this);
      r3 = this;
      var t5 = this.x();
      if (16 & this.f || this.v !== t5 || this.i === 0) {
        this.v = t5;
        this.f &= -17;
        this.i++;
      }
    } catch (i7) {
      this.v = i7;
      this.f |= 16;
      this.i++;
    }
    r3 = i6;
    b3(this);
    this.f &= -2;
    return true;
  };
  p4.prototype.S = function(i6) {
    if (this.t === undefined) {
      this.f |= 36;
      for (var t5 = this.s;t5 !== undefined; t5 = t5.n)
        t5.S.S(t5);
    }
    l4.prototype.S.call(this, i6);
  };
  p4.prototype.U = function(i6) {
    if (this.t !== undefined) {
      l4.prototype.U.call(this, i6);
      if (this.t === undefined) {
        this.f &= -33;
        for (var t5 = this.s;t5 !== undefined; t5 = t5.n)
          t5.S.U(t5);
      }
    }
  };
  p4.prototype.N = function() {
    if (!(2 & this.f)) {
      this.f |= 6;
      for (var i6 = this.t;i6 !== undefined; i6 = i6.x)
        i6.t.N();
    }
  };
  Object.defineProperty(p4.prototype, "value", { get: function() {
    if (1 & this.f)
      throw new Error("Cycle detected");
    var i6 = a4(this);
    this.h();
    if (i6 !== undefined)
      i6.i = this.i;
    if (16 & this.f)
      throw this.v;
    return this.v;
  } });
  function g2(i6, t5) {
    return new p4(i6, t5);
  }
  function S2(i6) {
    var n3 = i6.m;
    i6.m = undefined;
    if (typeof n3 == "function") {
      s4++;
      var o4 = r3;
      r3 = undefined;
      try {
        n3();
      } catch (t5) {
        i6.f &= -2;
        i6.f |= 8;
        m4(i6);
        throw t5;
      } finally {
        r3 = o4;
        t4();
      }
    }
  }
  function m4(i6) {
    for (var t5 = i6.s;t5 !== undefined; t5 = t5.n)
      t5.S.U(t5);
    i6.x = undefined;
    i6.s = undefined;
    S2(i6);
  }
  function x2(i6) {
    if (r3 !== this)
      throw new Error("Out-of-order effect");
    b3(this);
    r3 = i6;
    this.f &= -2;
    if (8 & this.f)
      m4(this);
    t4();
  }
  function E2(i6, t5) {
    this.x = i6;
    this.m = undefined;
    this.s = undefined;
    this.u = undefined;
    this.f = 32;
    this.name = t5 == null ? undefined : t5.name;
    if (f4)
      f4.push(this);
  }
  E2.prototype.c = function() {
    var i6 = this.S();
    try {
      if (8 & this.f)
        return;
      if (this.x === undefined)
        return;
      var t5 = this.x();
      if (typeof t5 == "function")
        this.m = t5;
    } finally {
      i6();
    }
  };
  E2.prototype.S = function() {
    if (1 & this.f)
      throw new Error("Cycle detected");
    this.f |= 1;
    this.f &= -9;
    S2(this);
    _2(this);
    s4++;
    var i6 = r3;
    r3 = this;
    return x2.bind(this, i6);
  };
  E2.prototype.N = function() {
    if (!(2 & this.f)) {
      this.f |= 2;
      this.u = h4;
      h4 = this;
    }
  };
  E2.prototype.d = function() {
    this.f |= 8;
    if (!(1 & this.f))
      m4(this);
  };
  E2.prototype.dispose = function() {
    this.d();
  };
  function C3(i6, t5) {
    var n3 = new E2(i6, t5);
    try {
      n3.c();
    } catch (i7) {
      n3.d();
      throw i7;
    }
    var r4 = n3.d.bind(n3);
    r4[Symbol.dispose] = r4;
    return r4;
  }
  function O2(i6) {
    return function() {
      var t5 = arguments, r4 = this;
      return n2(function() {
        return o3(function() {
          return i6.apply(r4, [].slice.call(t5));
        });
      });
    };
  }
  function j3() {
    var i6 = f4;
    f4 = [];
    return function() {
      var t5 = f4;
      if (f4 && i6)
        i6 = i6.concat(f4);
      f4 = i6;
      return t5;
    };
  }
  function k3(i6) {
    return function() {
      var t5, n3, r4 = j3();
      try {
        n3 = i6.apply(undefined, [].slice.call(arguments));
      } catch (i7) {
        f4 = undefined;
        throw i7;
      } finally {
        t5 = r4();
      }
      for (var o4 in n3)
        if (typeof n3[o4] == "function")
          n3[o4] = O2(n3[o4]);
      n3[Symbol.dispose] = O2(function() {
        if (t5)
          for (var i7 = 0;i7 < t5.length; i7++)
            t5[i7].dispose();
        t5 = undefined;
      });
      return n3;
    };
  }

  // node_modules/@preact/signals/dist/signals.module.js
  var l5;
  var d5;
  var h5;
  var p5 = typeof window != "undefined" && !!window.__PREACT_SIGNALS_DEVTOOLS__;
  var m5 = [];
  var _3 = [];
  C3(function() {
    l5 = this.N;
  })();
  function g3(i6, r4) {
    l[i6] = r4.bind(null, l[i6] || function() {});
  }
  function b4(i6) {
    if (h5) {
      var n3 = h5;
      h5 = undefined;
      n3();
    }
    h5 = i6 && i6.S();
  }
  function y5(i6) {
    var n3 = this, t5 = i6.data, e4 = useSignal(t5);
    e4.value = t5;
    var f5 = T2(function() {
      var i7 = n3, t6 = n3.__v;
      while (t6 = t6.__)
        if (t6.__c) {
          t6.__c.__$f |= 4;
          break;
        }
      var o4 = g2(function() {
        var i8 = e4.value.value;
        return i8 === 0 ? 0 : i8 === true ? "" : i8 || "";
      }), f6 = g2(function() {
        return !Array.isArray(o4.value) && !t(o4.value);
      }), a6 = C3(function() {
        this.N = F2;
        if (f6.value) {
          var n4 = o4.value;
          if (i7.__v && i7.__v.__e && i7.__v.__e.nodeType === 3)
            i7.__v.__e.data = n4;
        }
      }), v6 = n3.__$u.d;
      n3.__$u.d = function() {
        a6();
        v6.call(this);
      };
      return [f6, o4];
    }, []), a5 = f5[0], v5 = f5[1];
    return a5.value ? v5.peek() : v5.value;
  }
  y5.displayName = "ReactiveTextNode";
  Object.defineProperties(l4.prototype, { constructor: { configurable: true, value: undefined }, type: { configurable: true, value: y5 }, props: { configurable: true, get: function() {
    var i6 = this;
    return { data: { get value() {
      return i6.value;
    } } };
  } }, __b: { configurable: true, value: 1 } });
  g3("__b", function(i6, n3) {
    if (typeof n3.type == "string") {
      var r4, t5 = n3.props;
      for (var o4 in t5)
        if (o4 !== "children") {
          var e4 = t5[o4];
          if (e4 instanceof l4) {
            if (!r4)
              n3.__np = r4 = {};
            r4[o4] = e4;
            t5[o4] = e4.peek();
          }
        }
    }
    i6(n3);
  });
  g3("__r", function(i6, n3) {
    i6(n3);
    if (n3.type !== k) {
      b4();
      var r4, o4 = n3.__c;
      if (o4) {
        o4.__$f &= -2;
        if ((r4 = o4.__$u) === undefined)
          o4.__$u = r4 = function(i7, n4) {
            var r5;
            C3(function() {
              r5 = this;
            }, { name: n4 });
            r5.c = i7;
            return r5;
          }(function() {
            var i7;
            if (p5)
              (i7 = r4.y) == null || i7.call(r4);
            o4.__$f |= 1;
            o4.setState({});
          }, typeof n3.type == "function" ? n3.type.displayName || n3.type.name : "");
      }
      d5 = o4;
      b4(r4);
    }
  });
  g3("__e", function(i6, n3, r4, t5) {
    b4();
    d5 = undefined;
    i6(n3, r4, t5);
  });
  g3("diffed", function(i6, n3) {
    b4();
    d5 = undefined;
    var r4;
    if (typeof n3.type == "string" && (r4 = n3.__e)) {
      var { __np: t5, props: o4 } = n3;
      if (t5) {
        var e4 = r4.U;
        if (e4)
          for (var f5 in e4) {
            var u5 = e4[f5];
            if (u5 !== undefined && !(f5 in t5)) {
              u5.d();
              e4[f5] = undefined;
            }
          }
        else {
          e4 = {};
          r4.U = e4;
        }
        for (var a5 in t5) {
          var c5 = e4[a5], v5 = t5[a5];
          if (c5 === undefined) {
            c5 = w5(r4, a5, v5);
            e4[a5] = c5;
          } else
            c5.o(v5, o4);
        }
        for (var s5 in t5)
          o4[s5] = t5[s5];
      }
    }
    i6(n3);
  });
  function w5(i6, n3, r4, t5) {
    var o4 = n3 in i6 && i6.ownerSVGElement === undefined, e4 = y4(r4), f5 = r4.peek();
    return { o: function(i7, n4) {
      e4.value = i7;
      f5 = i7.peek();
    }, d: C3(function() {
      this.N = F2;
      var r5 = e4.value.value;
      if (f5 !== r5) {
        f5 = undefined;
        if (o4)
          i6[n3] = r5;
        else if (r5 != null && (r5 !== false || n3[4] === "-"))
          i6.setAttribute(n3, r5);
        else
          i6.removeAttribute(n3);
      } else
        f5 = undefined;
    }) };
  }
  g3("unmount", function(i6, n3) {
    if (typeof n3.type == "string") {
      var r4 = n3.__e;
      if (r4) {
        var t5 = r4.U;
        if (t5) {
          r4.U = undefined;
          for (var o4 in t5) {
            var e4 = t5[o4];
            if (e4)
              e4.d();
          }
        }
      }
      n3.__np = undefined;
    } else {
      var f5 = n3.__c;
      if (f5) {
        var u5 = f5.__$u;
        if (u5) {
          f5.__$u = undefined;
          u5.d();
        }
      }
    }
    i6(n3);
  });
  g3("__h", function(i6, n3, r4, t5) {
    if (t5 < 3 || t5 === 9)
      n3.__$f |= 2;
    i6(n3, r4, t5);
  });
  x.prototype.shouldComponentUpdate = function(i6, n3) {
    if (this.__R)
      return true;
    var r4 = this.__$u, t5 = r4 && r4.s !== undefined;
    for (var o4 in n3)
      return true;
    if (this.__f || typeof this.u == "boolean" && this.u === true) {
      var e4 = 2 & this.__$f;
      if (!(t5 || e4 || 4 & this.__$f))
        return true;
      if (1 & this.__$f)
        return true;
    } else {
      if (!(t5 || 4 & this.__$f))
        return true;
      if (3 & this.__$f)
        return true;
    }
    for (var f5 in i6)
      if (f5 !== "__source" && i6[f5] !== this.props[f5])
        return true;
    for (var u5 in this.props)
      if (!(u5 in i6))
        return true;
    return false;
  };
  function useSignal(i6, n3) {
    return T2(function() {
      return y4(i6, n3);
    }, []);
  }
  function useComputed(i6, n3) {
    var r4 = A2(i6);
    r4.current = i6;
    d5.__$f |= 4;
    return T2(function() {
      return g2(function() {
        return r4.current();
      }, n3);
    }, []);
  }
  var k4 = typeof requestAnimationFrame == "undefined" ? setTimeout : function(i6) {
    var n3 = function() {
      clearTimeout(r4);
      cancelAnimationFrame(t5);
      i6();
    }, r4 = setTimeout(n3, 35), t5 = requestAnimationFrame(n3);
  };
  var q2 = function(i6) {
    queueMicrotask(function() {
      queueMicrotask(i6);
    });
  };
  function A3() {
    n2(function() {
      var i6;
      while (i6 = m5.shift())
        l5.call(i6);
    });
  }
  function T3() {
    if (m5.push(this) === 1)
      (l.requestAnimationFrame || k4)(A3);
  }
  function x3() {
    n2(function() {
      var i6;
      while (i6 = _3.shift())
        l5.call(i6);
    });
  }
  function F2() {
    if (_3.push(this) === 1)
      (l.requestAnimationFrame || q2)(x3);
  }
  function useSignalEffect(i6, n3) {
    var r4 = A2(i6);
    r4.current = i6;
    y3(function() {
      return C3(function() {
        this.N = T3;
        return r4.current();
      }, n3);
    }, []);
  }
  function M2(i6) {
    var n3 = T2(function() {
      return i6();
    }, []);
    y3(function() {
      return n3[Symbol.dispose];
    }, [n3]);
    return n3;
  }

  // node_modules/@preact/signals/utils/dist/utils.module.js
  init_preact_module();
  var i6 = function(n3) {
    return typeof n3.children == "function" ? n3.children(n3.v, n3.i) : n3.children;
  };
  i6.displayName = "Item";
  function o4(n3) {
    var t5 = typeof n3.when == "function" ? n3.when() : n3.when.value;
    if (!t5)
      return n3.fallback || null;
    else
      return _(i6, { v: t5, children: n3.children });
  }
  o4.displayName = "Show";
  function u5(o5) {
    var u6 = T2(function() {
      return new Map;
    }, []), f5 = typeof o5.each == "function" ? o5.each() : o5.each, c5 = f5 instanceof l4 ? f5.value : f5;
    if (!c5.length)
      return o5.fallback || null;
    var a5 = new Set(u6.keys()), p6 = c5.map(function(n3, t5) {
      a5.delete(n3);
      if (!u6.has(n3)) {
        var e4 = _(i6, { v: n3, i: t5, children: o5.children });
        u6.set(n3, e4);
        return e4;
      }
      return u6.get(n3);
    });
    a5.forEach(function(n3) {
      u6.delete(n3);
    });
    return _(k, null, p6);
  }
  u5.displayName = "For";

  // node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js
  init_preact_module();
  init_preact_module();
  var f5 = 0;
  function u6(e4, t5, n3, o5, i7, u7) {
    t5 || (t5 = {});
    var a5, c5, p6 = t5;
    if ("ref" in p6)
      for (c5 in p6 = {}, t5)
        c5 == "ref" ? a5 = t5[c5] : p6[c5] = t5[c5];
    var l6 = { type: e4, props: p6, key: n3, ref: a5, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: undefined, __v: --f5, __i: -1, __u: 0, __source: i7, __self: u7 };
    if (typeof e4 == "function" && (a5 = e4.defaultProps))
      for (c5 in a5)
        p6[c5] === undefined && (p6[c5] = a5[c5]);
    return l.vnode && l.vnode(l6), l6;
  }

  // src/signals-test.tsx
  var results = y4([]);
  var autoCount = y4(0);
  var t1Renders = 0;
  function Test1_AutoSubscribe() {
    t1Renders++;
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 1: Auto-subscribe"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "signal.value in JSX: ",
            /* @__PURE__ */ u6("strong", {
              children: autoCount.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "dim",
          children: [
            "Component renders: ",
            t1Renders
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            autoCount.value++;
          },
          children: "Increment"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "If the number updates when you click, auto-subscribe works with Bun's bundler."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var bridgeSignal = y4(0);
  function Test2_Bridge() {
    const [local, setLocal] = d3(bridgeSignal.value);
    useSignalEffect(() => {
      setLocal(bridgeSignal.value);
    });
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 2: useSignalEffect bridge"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "Signal: ",
            /* @__PURE__ */ u6("strong", {
              id: "t2-signal",
              children: bridgeSignal.value
            }, undefined, false, undefined, this),
            " | Local state: ",
            /* @__PURE__ */ u6("strong", {
              id: "t2-local",
              children: local
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            bridgeSignal.value++;
          },
          children: "Increment signal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: 'Both numbers should update together. If only "Signal" updates, auto-subscribe works but bridge is redundant. If neither updates, both are broken.'
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var CounterModel = k3(() => {
    const count = y4(0);
    const doubled = g2(() => count.value * 2);
    const increment = O2(() => {
      count.value++;
    });
    const reset = O2(() => {
      count.value = 0;
    });
    return { count, doubled, increment, reset };
  });
  function Test3_Model() {
    const m6 = M2(CounterModel);
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 3: createModel + useModel"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "Count: ",
            /* @__PURE__ */ u6("strong", {
              children: m6.count.value
            }, undefined, false, undefined, this),
            " | Doubled:",
            " ",
            /* @__PURE__ */ u6("strong", {
              children: m6.doubled.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: m6.increment,
          children: "+1"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: m6.reset,
          children: "Reset"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "Tests model creation, computed derivation, and action batching."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var modalEvent = y4(null);
  function Test4_Modal() {
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 4: Modal (conditional render from signal)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            modalEvent.value = { id: 1, name: "Cat detected!" };
          },
          children: "Open Modal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            modalEvent.value = null;
          },
          children: "Close Modal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "modalEvent: ",
            /* @__PURE__ */ u6("code", {
              children: JSON.stringify(modalEvent.value)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        modalEvent.value && /* @__PURE__ */ u6("div", {
          class: "mock-modal",
          children: /* @__PURE__ */ u6("div", {
            class: "mock-modal-content",
            children: [
              /* @__PURE__ */ u6("strong", {
                children: "Modal Open!"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u6("p", {
                children: [
                  "Event: ",
                  modalEvent.value.name,
                  " (id=",
                  modalEvent.value.id,
                  ")"
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ u6("button", {
                onClick: () => {
                  modalEvent.value = null;
                },
                children: "×"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: `If the modal does NOT appear when clicking "Open Modal", auto-subscribe is broken and the component doesn't re-render on signal change.`
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test4b_ModalBridge() {
    const [ev, setEv] = d3(modalEvent.value);
    useSignalEffect(() => {
      setEv(modalEvent.value);
    });
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 4b: Modal (bridge workaround)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            modalEvent.value = { id: 2, name: "Dog detected!" };
          },
          children: "Open Modal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            modalEvent.value = null;
          },
          children: "Close"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "local ev: ",
            /* @__PURE__ */ u6("code", {
              children: JSON.stringify(ev)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        ev && /* @__PURE__ */ u6("div", {
          class: "mock-modal",
          children: /* @__PURE__ */ u6("div", {
            class: "mock-modal-content",
            children: [
              /* @__PURE__ */ u6("strong", {
                children: "Bridge Modal Open!"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u6("p", {
                children: [
                  "Event: ",
                  ev.name,
                  " (id=",
                  ev.id,
                  ")"
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ u6("button", {
                onClick: () => {
                  modalEvent.value = null;
                },
                children: "×"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "Same modal but using useSignalEffect→useState bridge."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var ModalStore = k3(() => {
    const selected = y4(null);
    const items = y4([
      { id: 1, name: "Chatora sleeping" },
      { id: 2, name: "Mike eating" },
      { id: 3, name: "Kijitora playing" }
    ]);
    const openModal = O2((item) => {
      selected.value = item;
    });
    const closeModal = O2(() => {
      selected.value = null;
    });
    return { selected, items, openModal, closeModal };
  });
  function Test5_StoreModal() {
    const store = M2(ModalStore);
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 5: useModel + modal (production pattern)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("div", {
          class: "item-list",
          children: store.items.value.map((item) => /* @__PURE__ */ u6("button", {
            onClick: () => store.openModal(item),
            children: item.name
          }, item.id, false, undefined, this))
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "selected: ",
            /* @__PURE__ */ u6("code", {
              children: JSON.stringify(store.selected.value)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        store.selected.value && /* @__PURE__ */ u6("div", {
          class: "mock-modal",
          children: /* @__PURE__ */ u6("div", {
            class: "mock-modal-content",
            children: [
              /* @__PURE__ */ u6("strong", {
                children: store.selected.value.name
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u6("button", {
                onClick: store.closeModal,
                children: "×"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "This is the exact pattern from app.tsx. If the modal doesn't appear, createModel + auto-subscribe is the problem."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test5b_StoreModalBridge() {
    const store = M2(ModalStore);
    const [sel, setSel] = d3(store.selected.value);
    useSignalEffect(() => {
      setSel(store.selected.value);
    });
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 5b: useModel + bridge modal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("div", {
          class: "item-list",
          children: store.items.value.map((item) => /* @__PURE__ */ u6("button", {
            onClick: () => store.openModal(item),
            children: item.name
          }, item.id, false, undefined, this))
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "local sel: ",
            /* @__PURE__ */ u6("code", {
              children: JSON.stringify(sel)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        sel && /* @__PURE__ */ u6("div", {
          class: "mock-modal",
          children: /* @__PURE__ */ u6("div", {
            class: "mock-modal-content",
            children: [
              /* @__PURE__ */ u6("strong", {
                children: sel.name
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u6("button", {
                onClick: store.closeModal,
                children: "×"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "Same but with useSignalEffect bridge."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test6_UseSignal() {
    const count = useSignal(0);
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 6: useSignal (component-local)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "Count: ",
            /* @__PURE__ */ u6("strong", {
              children: count.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            count.value++;
          },
          children: "+1"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "useSignal creates a component-scoped signal."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test7_UseComputed() {
    const count = useSignal(0);
    const label = useComputed(() => count.value === 0 ? "zero" : count.value < 5 ? "few" : "many");
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 7: useComputed"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "Count: ",
            /* @__PURE__ */ u6("strong", {
              children: count.value
            }, undefined, false, undefined, this),
            " | Label: ",
            /* @__PURE__ */ u6("strong", {
              children: label.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            count.value++;
          },
          children: "+1"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            count.value = 0;
          },
          children: "Reset"
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var batchA = y4(0);
  var batchB = y4(0);
  function Test8_Batch() {
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 8: batch()"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "A: ",
            /* @__PURE__ */ u6("strong", {
              children: batchA.value
            }, undefined, false, undefined, this),
            " | B: ",
            /* @__PURE__ */ u6("strong", {
              children: batchB.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            n2(() => {
              batchA.value++;
              batchB.value += 10;
            });
          },
          children: "Batch update (A+1, B+10)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "Should update both in a single render."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test9_Diagnostic() {
    let info = {};
    try {
      const opts = globalThis.__PREACT_SIGNALS_HOOKS__;
      info.globalHook = opts ? "found" : "not found";
    } catch {}
    try {
      const preact = (init_preact_module(), __toCommonJS(exports_preact_module));
      const optKeys = Object.keys(preact.options || {});
      info.preactOptions = optKeys.join(", ") || "(empty)";
    } catch {
      info.preactOptions = "(cannot access)";
    }
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 9: Diagnostics"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("pre", {
          children: JSON.stringify(info, null, 2)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          children: [
            "Side-effect import present:",
            " ",
            /* @__PURE__ */ u6("strong", {
              children: typeof y4 === "function" ? "YES" : "NO"
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "If preactOptions shows __b, __r, diffed, unmount — hooks are installed."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var showSignal = y4(null);
  function Test10_Show() {
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: [
            "Test 10: ",
            "<Show>",
            " component"
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            showSignal.value = "Hello from Show!";
          },
          children: "Show content"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            showSignal.value = null;
          },
          children: "Hide"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6(o4, {
          when: showSignal,
          children: (val) => /* @__PURE__ */ u6("div", {
            class: "mock-modal",
            children: /* @__PURE__ */ u6("div", {
              class: "mock-modal-content",
              children: /* @__PURE__ */ u6("strong", {
                children: val
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: [
            "<Show when={signal}>",
            " renders children only when signal is truthy. No parent re-render needed."
          ]
        }, undefined, true, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var showModalEvent = y4(null);
  function Test10b_ShowModal() {
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: [
            "Test 10b: ",
            "<Show>",
            " modal pattern"
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("div", {
          class: "item-list",
          children: [
            /* @__PURE__ */ u6("button", {
              onClick: () => {
                showModalEvent.value = { id: 1, name: "Chatora" };
              },
              children: "Chatora"
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u6("button", {
              onClick: () => {
                showModalEvent.value = { id: 2, name: "Mike" };
              },
              children: "Mike"
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6(o4, {
          when: showModalEvent,
          children: (ev) => /* @__PURE__ */ u6("div", {
            class: "mock-modal",
            children: /* @__PURE__ */ u6("div", {
              class: "mock-modal-content",
              children: [
                /* @__PURE__ */ u6("strong", {
                  children: ev.name
                }, undefined, false, undefined, this),
                " (id=",
                ev.id,
                ")",
                /* @__PURE__ */ u6("button", {
                  onClick: () => {
                    showModalEvent.value = null;
                  },
                  children: "×"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "This is the ideal modal pattern — no useState, no bridge, no parent re-render."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var listItems = y4([
    { id: 1, name: "Chatora" },
    { id: 2, name: "Mike" },
    { id: 3, name: "Kijitora" }
  ]);
  function Test11_For() {
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: [
            "Test 11: ",
            "<For>",
            " component"
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6(u5, {
          each: listItems,
          children: (item) => /* @__PURE__ */ u6("div", {
            style: "padding: 4px 0;",
            children: [
              "#",
              item.id,
              " — ",
              /* @__PURE__ */ u6("strong", {
                children: item.name
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            listItems.value = [
              ...listItems.value,
              { id: listItems.value.length + 1, name: `Pet #${listItems.value.length + 1}` }
            ];
          },
          children: "Add item"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("button", {
          onClick: () => {
            listItems.value = listItems.value.slice(0, -1);
          },
          children: "Remove last"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: [
            "<For each={signal}>",
            " efficiently renders lists. Items should add/remove without full re-render."
          ]
        }, undefined, true, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var FullStore = k3(() => {
    const selected = y4(null);
    const items = y4([
      { id: 1, name: "Chatora sleeping" },
      { id: 2, name: "Mike eating" },
      { id: 3, name: "Kijitora playing" }
    ]);
    const openModal = O2((item) => {
      selected.value = item;
    });
    const closeModal = O2(() => {
      selected.value = null;
    });
    return { selected, items, openModal, closeModal };
  });
  function Test12_FullPattern() {
    const store = M2(FullStore);
    return /* @__PURE__ */ u6("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u6("h3", {
          children: "Test 12: useModel + Show + For (target pattern)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6(u5, {
          each: store.items,
          children: (item) => /* @__PURE__ */ u6("button", {
            onClick: () => store.openModal(item),
            children: item.name
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6(o4, {
          when: store.selected,
          children: (ev) => /* @__PURE__ */ u6("div", {
            class: "mock-modal",
            children: /* @__PURE__ */ u6("div", {
              class: "mock-modal-content",
              children: [
                /* @__PURE__ */ u6("strong", {
                  children: ev.name
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u6("button", {
                  onClick: store.closeModal,
                  children: "×"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "hint",
          children: "The ideal production pattern: createModel + useModel + Show + For. No useState, no useSignalEffect bridge, no parent re-renders."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function SignalsTestApp() {
    return /* @__PURE__ */ u6("div", {
      class: "test-app",
      children: [
        /* @__PURE__ */ u6("h1", {
          children: "@preact/signals Test Bench"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("p", {
          class: "subtitle",
          children: [
            "Verify signal reactivity patterns before production use.",
            /* @__PURE__ */ u6("br", {}, undefined, false, undefined, this),
            "Build: Bun ",
            typeof Bun !== "undefined" ? "runtime" : "bundled",
            " | @preact/signals 2.8.2"
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("div", {
          class: "test-grid",
          children: [
            /* @__PURE__ */ u6(Test1_AutoSubscribe, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test2_Bridge, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test3_Model, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test6_UseSignal, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test7_UseComputed, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test8_Batch, {}, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("h2", {
          children: "Modal Tests (the broken case)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("div", {
          class: "test-grid",
          children: [
            /* @__PURE__ */ u6(Test4_Modal, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test4b_ModalBridge, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test5_StoreModal, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test5b_StoreModalBridge, {}, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("h2", {
          children: "Show / For (declarative pattern)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6("div", {
          class: "test-grid",
          children: [
            /* @__PURE__ */ u6(Test10_Show, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test10b_ShowModal, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test11_For, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u6(Test12_FullPattern, {}, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u6("h2", {
          children: "Diagnostics"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u6(Test9_Diagnostic, {}, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var root = document.getElementById("app");
  if (!root)
    throw new Error("#app root not found");
  J(/* @__PURE__ */ u6(SignalsTestApp, {}, undefined, false, undefined, this), root);
})();

//# debugId=E2E69024AB62533B64756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vbm9kZV9tb2R1bGVzL3ByZWFjdC9kaXN0L3ByZWFjdC5tb2R1bGUuanMiLCAiLi4vbm9kZV9tb2R1bGVzL3ByZWFjdC9kZWJ1Zy9kaXN0L2RlYnVnLm1vZHVsZS5qcyIsICIuLi9ub2RlX21vZHVsZXMvcHJlYWN0L2RldnRvb2xzL2Rpc3QvZGV2dG9vbHMubW9kdWxlLmpzIiwgIi4uL3NyYy9zaWduYWxzLXRlc3QudHN4IiwgIi4uL25vZGVfbW9kdWxlcy9wcmVhY3QvaG9va3MvZGlzdC9ob29rcy5tb2R1bGUuanMiLCAiLi4vbm9kZV9tb2R1bGVzL0BwcmVhY3Qvc2lnbmFscy9kaXN0L3NpZ25hbHMubW9kdWxlLmpzIiwgIi4uL25vZGVfbW9kdWxlcy9AcHJlYWN0L3NpZ25hbHMtY29yZS9kaXN0L3NpZ25hbHMtY29yZS5tb2R1bGUuanMiLCAiLi4vbm9kZV9tb2R1bGVzL0BwcmVhY3Qvc2lnbmFscy91dGlscy9kaXN0L3V0aWxzLm1vZHVsZS5qcyIsICIuLi9ub2RlX21vZHVsZXMvcHJlYWN0L2pzeC1ydW50aW1lL2Rpc3QvanN4UnVudGltZS5tb2R1bGUuanMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbCiAgICAidmFyIG4sbCx1LHQsaSxyLG8sZSxmLGMscyxhLGgscD17fSx2PVtdLHk9L2FjaXR8ZXgoPzpzfGd8bnxwfCQpfHJwaHxncmlkfG93c3xtbmN8bnR3fGluZVtjaF18em9vfF5vcmR8aXRlcmEvaSxkPUFycmF5LmlzQXJyYXk7ZnVuY3Rpb24gdyhuLGwpe2Zvcih2YXIgdSBpbiBsKW5bdV09bFt1XTtyZXR1cm4gbn1mdW5jdGlvbiBnKG4pe24mJm4ucGFyZW50Tm9kZSYmbi5wYXJlbnROb2RlLnJlbW92ZUNoaWxkKG4pfWZ1bmN0aW9uIF8obCx1LHQpe3ZhciBpLHIsbyxlPXt9O2ZvcihvIGluIHUpXCJrZXlcIj09bz9pPXVbb106XCJyZWZcIj09bz9yPXVbb106ZVtvXT11W29dO2lmKGFyZ3VtZW50cy5sZW5ndGg+MiYmKGUuY2hpbGRyZW49YXJndW1lbnRzLmxlbmd0aD4zP24uY2FsbChhcmd1bWVudHMsMik6dCksXCJmdW5jdGlvblwiPT10eXBlb2YgbCYmbnVsbCE9bC5kZWZhdWx0UHJvcHMpZm9yKG8gaW4gbC5kZWZhdWx0UHJvcHMpdm9pZCAwPT09ZVtvXSYmKGVbb109bC5kZWZhdWx0UHJvcHNbb10pO3JldHVybiBtKGwsZSxpLHIsbnVsbCl9ZnVuY3Rpb24gbShuLHQsaSxyLG8pe3ZhciBlPXt0eXBlOm4scHJvcHM6dCxrZXk6aSxyZWY6cixfX2s6bnVsbCxfXzpudWxsLF9fYjowLF9fZTpudWxsLF9fYzpudWxsLGNvbnN0cnVjdG9yOnZvaWQgMCxfX3Y6bnVsbD09bz8rK3U6byxfX2k6LTEsX191OjB9O3JldHVybiBudWxsPT1vJiZudWxsIT1sLnZub2RlJiZsLnZub2RlKGUpLGV9ZnVuY3Rpb24gYigpe3JldHVybntjdXJyZW50Om51bGx9fWZ1bmN0aW9uIGsobil7cmV0dXJuIG4uY2hpbGRyZW59ZnVuY3Rpb24geChuLGwpe3RoaXMucHJvcHM9bix0aGlzLmNvbnRleHQ9bH1mdW5jdGlvbiBTKG4sbCl7aWYobnVsbD09bClyZXR1cm4gbi5fXz9TKG4uX18sbi5fX2krMSk6bnVsbDtmb3IodmFyIHU7bDxuLl9fay5sZW5ndGg7bCsrKWlmKG51bGwhPSh1PW4uX19rW2xdKSYmbnVsbCE9dS5fX2UpcmV0dXJuIHUuX19lO3JldHVyblwiZnVuY3Rpb25cIj09dHlwZW9mIG4udHlwZT9TKG4pOm51bGx9ZnVuY3Rpb24gQyhuKXtpZihuLl9fUCYmbi5fX2Qpe3ZhciB1PW4uX192LHQ9dS5fX2UsaT1bXSxyPVtdLG89dyh7fSx1KTtvLl9fdj11Ll9fdisxLGwudm5vZGUmJmwudm5vZGUobykseihuLl9fUCxvLHUsbi5fX24sbi5fX1AubmFtZXNwYWNlVVJJLDMyJnUuX191P1t0XTpudWxsLGksbnVsbD09dD9TKHUpOnQsISEoMzImdS5fX3UpLHIpLG8uX192PXUuX192LG8uX18uX19rW28uX19pXT1vLFYoaSxvLHIpLHUuX19lPXUuX189bnVsbCxvLl9fZSE9dCYmTShvKX19ZnVuY3Rpb24gTShuKXtpZihudWxsIT0obj1uLl9fKSYmbnVsbCE9bi5fX2MpcmV0dXJuIG4uX19lPW4uX19jLmJhc2U9bnVsbCxuLl9fay5zb21lKGZ1bmN0aW9uKGwpe2lmKG51bGwhPWwmJm51bGwhPWwuX19lKXJldHVybiBuLl9fZT1uLl9fYy5iYXNlPWwuX19lfSksTShuKX1mdW5jdGlvbiAkKG4peyghbi5fX2QmJihuLl9fZD0hMCkmJmkucHVzaChuKSYmIUkuX19yKyt8fHIhPWwuZGVib3VuY2VSZW5kZXJpbmcpJiYoKHI9bC5kZWJvdW5jZVJlbmRlcmluZyl8fG8pKEkpfWZ1bmN0aW9uIEkoKXt0cnl7Zm9yKHZhciBuLGw9MTtpLmxlbmd0aDspaS5sZW5ndGg+bCYmaS5zb3J0KGUpLG49aS5zaGlmdCgpLGw9aS5sZW5ndGgsQyhuKX1maW5hbGx5e2kubGVuZ3RoPUkuX19yPTB9fWZ1bmN0aW9uIFAobixsLHUsdCxpLHIsbyxlLGYsYyxzKXt2YXIgYSxoLHksZCx3LGcsXyxtPXQmJnQuX19rfHx2LGI9bC5sZW5ndGg7Zm9yKGY9QSh1LGwsbSxmLGIpLGE9MDthPGI7YSsrKW51bGwhPSh5PXUuX19rW2FdKSYmKGg9LTEhPXkuX19pJiZtW3kuX19pXXx8cCx5Ll9faT1hLGc9eihuLHksaCxpLHIsbyxlLGYsYyxzKSxkPXkuX19lLHkucmVmJiZoLnJlZiE9eS5yZWYmJihoLnJlZiYmRChoLnJlZixudWxsLHkpLHMucHVzaCh5LnJlZix5Ll9fY3x8ZCx5KSksbnVsbD09dyYmbnVsbCE9ZCYmKHc9ZCksKF89ISEoNCZ5Ll9fdSkpfHxoLl9faz09PXkuX19rP2Y9SCh5LGYsbixfKTpcImZ1bmN0aW9uXCI9PXR5cGVvZiB5LnR5cGUmJnZvaWQgMCE9PWc/Zj1nOmQmJihmPWQubmV4dFNpYmxpbmcpLHkuX191Jj0tNyk7cmV0dXJuIHUuX19lPXcsZn1mdW5jdGlvbiBBKG4sbCx1LHQsaSl7dmFyIHIsbyxlLGYsYyxzPXUubGVuZ3RoLGE9cyxoPTA7Zm9yKG4uX19rPW5ldyBBcnJheShpKSxyPTA7cjxpO3IrKyludWxsIT0obz1sW3JdKSYmXCJib29sZWFuXCIhPXR5cGVvZiBvJiZcImZ1bmN0aW9uXCIhPXR5cGVvZiBvPyhcInN0cmluZ1wiPT10eXBlb2Ygb3x8XCJudW1iZXJcIj09dHlwZW9mIG98fFwiYmlnaW50XCI9PXR5cGVvZiBvfHxvLmNvbnN0cnVjdG9yPT1TdHJpbmc/bz1uLl9fa1tyXT1tKG51bGwsbyxudWxsLG51bGwsbnVsbCk6ZChvKT9vPW4uX19rW3JdPW0oayx7Y2hpbGRyZW46b30sbnVsbCxudWxsLG51bGwpOnZvaWQgMD09PW8uY29uc3RydWN0b3ImJm8uX19iPjA/bz1uLl9fa1tyXT1tKG8udHlwZSxvLnByb3BzLG8ua2V5LG8ucmVmP28ucmVmOm51bGwsby5fX3YpOm4uX19rW3JdPW8sZj1yK2gsby5fXz1uLG8uX19iPW4uX19iKzEsZT1udWxsLC0xIT0oYz1vLl9faT1UKG8sdSxmLGEpKSYmKGEtLSwoZT11W2NdKSYmKGUuX191fD0yKSksbnVsbD09ZXx8bnVsbD09ZS5fX3Y/KC0xPT1jJiYoaT5zP2gtLTppPHMmJmgrKyksXCJmdW5jdGlvblwiIT10eXBlb2Ygby50eXBlJiYoby5fX3V8PTQpKTpjIT1mJiYoYz09Zi0xP2gtLTpjPT1mKzE/aCsrOihjPmY/aC0tOmgrKyxvLl9fdXw9NCkpKTpuLl9fa1tyXT1udWxsO2lmKGEpZm9yKHI9MDtyPHM7cisrKW51bGwhPShlPXVbcl0pJiYwPT0oMiZlLl9fdSkmJihlLl9fZT09dCYmKHQ9UyhlKSksRShlLGUpKTtyZXR1cm4gdH1mdW5jdGlvbiBIKG4sbCx1LHQpe3ZhciBpLHI7aWYoXCJmdW5jdGlvblwiPT10eXBlb2Ygbi50eXBlKXtmb3IoaT1uLl9fayxyPTA7aSYmcjxpLmxlbmd0aDtyKyspaVtyXSYmKGlbcl0uX189bixsPUgoaVtyXSxsLHUsdCkpO3JldHVybiBsfW4uX19lIT1sJiYodCYmKGwmJm4udHlwZSYmIWwucGFyZW50Tm9kZSYmKGw9UyhuKSksdS5pbnNlcnRCZWZvcmUobi5fX2UsbHx8bnVsbCkpLGw9bi5fX2UpO2Rve2w9bCYmbC5uZXh0U2libGluZ313aGlsZShudWxsIT1sJiY4PT1sLm5vZGVUeXBlKTtyZXR1cm4gbH1mdW5jdGlvbiBMKG4sbCl7cmV0dXJuIGw9bHx8W10sbnVsbD09bnx8XCJib29sZWFuXCI9PXR5cGVvZiBufHwoZChuKT9uLnNvbWUoZnVuY3Rpb24obil7TChuLGwpfSk6bC5wdXNoKG4pKSxsfWZ1bmN0aW9uIFQobixsLHUsdCl7dmFyIGkscixvLGU9bi5rZXksZj1uLnR5cGUsYz1sW3VdLHM9bnVsbCE9YyYmMD09KDImYy5fX3UpO2lmKG51bGw9PT1jJiZudWxsPT1lfHxzJiZlPT1jLmtleSYmZj09Yy50eXBlKXJldHVybiB1O2lmKHQ+KHM/MTowKSlmb3IoaT11LTEscj11KzE7aT49MHx8cjxsLmxlbmd0aDspaWYobnVsbCE9KGM9bFtvPWk+PTA/aS0tOnIrK10pJiYwPT0oMiZjLl9fdSkmJmU9PWMua2V5JiZmPT1jLnR5cGUpcmV0dXJuIG87cmV0dXJuLTF9ZnVuY3Rpb24gaihuLGwsdSl7XCItXCI9PWxbMF0/bi5zZXRQcm9wZXJ0eShsLG51bGw9PXU/XCJcIjp1KTpuW2xdPW51bGw9PXU/XCJcIjpcIm51bWJlclwiIT10eXBlb2YgdXx8eS50ZXN0KGwpP3U6dStcInB4XCJ9ZnVuY3Rpb24gRihuLGwsdSx0LGkpe3ZhciByLG87bjppZihcInN0eWxlXCI9PWwpaWYoXCJzdHJpbmdcIj09dHlwZW9mIHUpbi5zdHlsZS5jc3NUZXh0PXU7ZWxzZXtpZihcInN0cmluZ1wiPT10eXBlb2YgdCYmKG4uc3R5bGUuY3NzVGV4dD10PVwiXCIpLHQpZm9yKGwgaW4gdCl1JiZsIGluIHV8fGoobi5zdHlsZSxsLFwiXCIpO2lmKHUpZm9yKGwgaW4gdSl0JiZ1W2xdPT10W2xdfHxqKG4uc3R5bGUsbCx1W2xdKX1lbHNlIGlmKFwib1wiPT1sWzBdJiZcIm5cIj09bFsxXSlyPWwhPShsPWwucmVwbGFjZShmLFwiJDFcIikpLG89bC50b0xvd2VyQ2FzZSgpLGw9byBpbiBufHxcIm9uRm9jdXNPdXRcIj09bHx8XCJvbkZvY3VzSW5cIj09bD9vLnNsaWNlKDIpOmwuc2xpY2UoMiksbi5sfHwobi5sPXt9KSxuLmxbbCtyXT11LHU/dD91LnU9dC51Oih1LnU9YyxuLmFkZEV2ZW50TGlzdGVuZXIobCxyP2E6cyxyKSk6bi5yZW1vdmVFdmVudExpc3RlbmVyKGwscj9hOnMscik7ZWxzZXtpZihcImh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnXCI9PWkpbD1sLnJlcGxhY2UoL3hsaW5rKEh8OmgpLyxcImhcIikucmVwbGFjZSgvc05hbWUkLyxcInNcIik7ZWxzZSBpZihcIndpZHRoXCIhPWwmJlwiaGVpZ2h0XCIhPWwmJlwiaHJlZlwiIT1sJiZcImxpc3RcIiE9bCYmXCJmb3JtXCIhPWwmJlwidGFiSW5kZXhcIiE9bCYmXCJkb3dubG9hZFwiIT1sJiZcInJvd1NwYW5cIiE9bCYmXCJjb2xTcGFuXCIhPWwmJlwicm9sZVwiIT1sJiZcInBvcG92ZXJcIiE9bCYmbCBpbiBuKXRyeXtuW2xdPW51bGw9PXU/XCJcIjp1O2JyZWFrIG59Y2F0Y2gobil7fVwiZnVuY3Rpb25cIj09dHlwZW9mIHV8fChudWxsPT11fHwhMT09PXUmJlwiLVwiIT1sWzRdP24ucmVtb3ZlQXR0cmlidXRlKGwpOm4uc2V0QXR0cmlidXRlKGwsXCJwb3BvdmVyXCI9PWwmJjE9PXU/XCJcIjp1KSl9fWZ1bmN0aW9uIE8obil7cmV0dXJuIGZ1bmN0aW9uKHUpe2lmKHRoaXMubCl7dmFyIHQ9dGhpcy5sW3UudHlwZStuXTtpZihudWxsPT11LnQpdS50PWMrKztlbHNlIGlmKHUudDx0LnUpcmV0dXJuO3JldHVybiB0KGwuZXZlbnQ/bC5ldmVudCh1KTp1KX19fWZ1bmN0aW9uIHoobix1LHQsaSxyLG8sZSxmLGMscyl7dmFyIGEsaCxwLHksXyxtLGIsUyxDLE0sJCxJLEEsSCxMLFQ9dS50eXBlO2lmKHZvaWQgMCE9PXUuY29uc3RydWN0b3IpcmV0dXJuIG51bGw7MTI4JnQuX191JiYoYz0hISgzMiZ0Ll9fdSksbz1bZj11Ll9fZT10Ll9fZV0pLChhPWwuX19iKSYmYSh1KTtuOmlmKFwiZnVuY3Rpb25cIj09dHlwZW9mIFQpdHJ5e2lmKFM9dS5wcm9wcyxDPVQucHJvdG90eXBlJiZULnByb3RvdHlwZS5yZW5kZXIsTT0oYT1ULmNvbnRleHRUeXBlKSYmaVthLl9fY10sJD1hP00/TS5wcm9wcy52YWx1ZTphLl9fOmksdC5fX2M/Yj0oaD11Ll9fYz10Ll9fYykuX189aC5fX0U6KEM/dS5fX2M9aD1uZXcgVChTLCQpOih1Ll9fYz1oPW5ldyB4KFMsJCksaC5jb25zdHJ1Y3Rvcj1ULGgucmVuZGVyPUcpLE0mJk0uc3ViKGgpLGguc3RhdGV8fChoLnN0YXRlPXt9KSxoLl9fbj1pLHA9aC5fX2Q9ITAsaC5fX2g9W10saC5fc2I9W10pLEMmJm51bGw9PWguX19zJiYoaC5fX3M9aC5zdGF0ZSksQyYmbnVsbCE9VC5nZXREZXJpdmVkU3RhdGVGcm9tUHJvcHMmJihoLl9fcz09aC5zdGF0ZSYmKGguX19zPXcoe30saC5fX3MpKSx3KGguX19zLFQuZ2V0RGVyaXZlZFN0YXRlRnJvbVByb3BzKFMsaC5fX3MpKSkseT1oLnByb3BzLF89aC5zdGF0ZSxoLl9fdj11LHApQyYmbnVsbD09VC5nZXREZXJpdmVkU3RhdGVGcm9tUHJvcHMmJm51bGwhPWguY29tcG9uZW50V2lsbE1vdW50JiZoLmNvbXBvbmVudFdpbGxNb3VudCgpLEMmJm51bGwhPWguY29tcG9uZW50RGlkTW91bnQmJmguX19oLnB1c2goaC5jb21wb25lbnREaWRNb3VudCk7ZWxzZXtpZihDJiZudWxsPT1ULmdldERlcml2ZWRTdGF0ZUZyb21Qcm9wcyYmUyE9PXkmJm51bGwhPWguY29tcG9uZW50V2lsbFJlY2VpdmVQcm9wcyYmaC5jb21wb25lbnRXaWxsUmVjZWl2ZVByb3BzKFMsJCksdS5fX3Y9PXQuX192fHwhaC5fX2UmJm51bGwhPWguc2hvdWxkQ29tcG9uZW50VXBkYXRlJiYhMT09PWguc2hvdWxkQ29tcG9uZW50VXBkYXRlKFMsaC5fX3MsJCkpe3UuX192IT10Ll9fdiYmKGgucHJvcHM9UyxoLnN0YXRlPWguX19zLGguX19kPSExKSx1Ll9fZT10Ll9fZSx1Ll9faz10Ll9fayx1Ll9fay5zb21lKGZ1bmN0aW9uKG4pe24mJihuLl9fPXUpfSksdi5wdXNoLmFwcGx5KGguX19oLGguX3NiKSxoLl9zYj1bXSxoLl9faC5sZW5ndGgmJmUucHVzaChoKTticmVhayBufW51bGwhPWguY29tcG9uZW50V2lsbFVwZGF0ZSYmaC5jb21wb25lbnRXaWxsVXBkYXRlKFMsaC5fX3MsJCksQyYmbnVsbCE9aC5jb21wb25lbnREaWRVcGRhdGUmJmguX19oLnB1c2goZnVuY3Rpb24oKXtoLmNvbXBvbmVudERpZFVwZGF0ZSh5LF8sbSl9KX1pZihoLmNvbnRleHQ9JCxoLnByb3BzPVMsaC5fX1A9bixoLl9fZT0hMSxJPWwuX19yLEE9MCxDKWguc3RhdGU9aC5fX3MsaC5fX2Q9ITEsSSYmSSh1KSxhPWgucmVuZGVyKGgucHJvcHMsaC5zdGF0ZSxoLmNvbnRleHQpLHYucHVzaC5hcHBseShoLl9faCxoLl9zYiksaC5fc2I9W107ZWxzZSBkb3toLl9fZD0hMSxJJiZJKHUpLGE9aC5yZW5kZXIoaC5wcm9wcyxoLnN0YXRlLGguY29udGV4dCksaC5zdGF0ZT1oLl9fc313aGlsZShoLl9fZCYmKytBPDI1KTtoLnN0YXRlPWguX19zLG51bGwhPWguZ2V0Q2hpbGRDb250ZXh0JiYoaT13KHcoe30saSksaC5nZXRDaGlsZENvbnRleHQoKSkpLEMmJiFwJiZudWxsIT1oLmdldFNuYXBzaG90QmVmb3JlVXBkYXRlJiYobT1oLmdldFNuYXBzaG90QmVmb3JlVXBkYXRlKHksXykpLEg9bnVsbCE9YSYmYS50eXBlPT09ayYmbnVsbD09YS5rZXk/cShhLnByb3BzLmNoaWxkcmVuKTphLGY9UChuLGQoSCk/SDpbSF0sdSx0LGkscixvLGUsZixjLHMpLGguYmFzZT11Ll9fZSx1Ll9fdSY9LTE2MSxoLl9faC5sZW5ndGgmJmUucHVzaChoKSxiJiYoaC5fX0U9aC5fXz1udWxsKX1jYXRjaChuKXtpZih1Ll9fdj1udWxsLGN8fG51bGwhPW8paWYobi50aGVuKXtmb3IodS5fX3V8PWM/MTYwOjEyODtmJiY4PT1mLm5vZGVUeXBlJiZmLm5leHRTaWJsaW5nOylmPWYubmV4dFNpYmxpbmc7b1tvLmluZGV4T2YoZildPW51bGwsdS5fX2U9Zn1lbHNle2ZvcihMPW8ubGVuZ3RoO0wtLTspZyhvW0xdKTtOKHUpfWVsc2UgdS5fX2U9dC5fX2UsdS5fX2s9dC5fX2ssbi50aGVufHxOKHUpO2wuX19lKG4sdSx0KX1lbHNlIG51bGw9PW8mJnUuX192PT10Ll9fdj8odS5fX2s9dC5fX2ssdS5fX2U9dC5fX2UpOmY9dS5fX2U9Qih0Ll9fZSx1LHQsaSxyLG8sZSxjLHMpO3JldHVybihhPWwuZGlmZmVkKSYmYSh1KSwxMjgmdS5fX3U/dm9pZCAwOmZ9ZnVuY3Rpb24gTihuKXtuJiYobi5fX2MmJihuLl9fYy5fX2U9ITApLG4uX19rJiZuLl9fay5zb21lKE4pKX1mdW5jdGlvbiBWKG4sdSx0KXtmb3IodmFyIGk9MDtpPHQubGVuZ3RoO2krKylEKHRbaV0sdFsrK2ldLHRbKytpXSk7bC5fX2MmJmwuX19jKHUsbiksbi5zb21lKGZ1bmN0aW9uKHUpe3RyeXtuPXUuX19oLHUuX19oPVtdLG4uc29tZShmdW5jdGlvbihuKXtuLmNhbGwodSl9KX1jYXRjaChuKXtsLl9fZShuLHUuX192KX19KX1mdW5jdGlvbiBxKG4pe3JldHVyblwib2JqZWN0XCIhPXR5cGVvZiBufHxudWxsPT1ufHxuLl9fYj4wP246ZChuKT9uLm1hcChxKTp3KHt9LG4pfWZ1bmN0aW9uIEIodSx0LGkscixvLGUsZixjLHMpe3ZhciBhLGgsdix5LHcsXyxtLGI9aS5wcm9wc3x8cCxrPXQucHJvcHMseD10LnR5cGU7aWYoXCJzdmdcIj09eD9vPVwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIjpcIm1hdGhcIj09eD9vPVwiaHR0cDovL3d3dy53My5vcmcvMTk5OC9NYXRoL01hdGhNTFwiOm98fChvPVwiaHR0cDovL3d3dy53My5vcmcvMTk5OS94aHRtbFwiKSxudWxsIT1lKWZvcihhPTA7YTxlLmxlbmd0aDthKyspaWYoKHc9ZVthXSkmJlwic2V0QXR0cmlidXRlXCJpbiB3PT0hIXgmJih4P3cubG9jYWxOYW1lPT14OjM9PXcubm9kZVR5cGUpKXt1PXcsZVthXT1udWxsO2JyZWFrfWlmKG51bGw9PXUpe2lmKG51bGw9PXgpcmV0dXJuIGRvY3VtZW50LmNyZWF0ZVRleHROb2RlKGspO3U9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudE5TKG8seCxrLmlzJiZrKSxjJiYobC5fX20mJmwuX19tKHQsZSksYz0hMSksZT1udWxsfWlmKG51bGw9PXgpYj09PWt8fGMmJnUuZGF0YT09a3x8KHUuZGF0YT1rKTtlbHNle2lmKGU9ZSYmbi5jYWxsKHUuY2hpbGROb2RlcyksIWMmJm51bGwhPWUpZm9yKGI9e30sYT0wO2E8dS5hdHRyaWJ1dGVzLmxlbmd0aDthKyspYlsodz11LmF0dHJpYnV0ZXNbYV0pLm5hbWVdPXcudmFsdWU7Zm9yKGEgaW4gYil3PWJbYV0sXCJkYW5nZXJvdXNseVNldElubmVySFRNTFwiPT1hP3Y9dzpcImNoaWxkcmVuXCI9PWF8fGEgaW4ga3x8XCJ2YWx1ZVwiPT1hJiZcImRlZmF1bHRWYWx1ZVwiaW4ga3x8XCJjaGVja2VkXCI9PWEmJlwiZGVmYXVsdENoZWNrZWRcImluIGt8fEYodSxhLG51bGwsdyxvKTtmb3IoYSBpbiBrKXc9a1thXSxcImNoaWxkcmVuXCI9PWE/eT13OlwiZGFuZ2Vyb3VzbHlTZXRJbm5lckhUTUxcIj09YT9oPXc6XCJ2YWx1ZVwiPT1hP189dzpcImNoZWNrZWRcIj09YT9tPXc6YyYmXCJmdW5jdGlvblwiIT10eXBlb2Ygd3x8YlthXT09PXd8fEYodSxhLHcsYlthXSxvKTtpZihoKWN8fHYmJihoLl9faHRtbD09di5fX2h0bWx8fGguX19odG1sPT11LmlubmVySFRNTCl8fCh1LmlubmVySFRNTD1oLl9faHRtbCksdC5fX2s9W107ZWxzZSBpZih2JiYodS5pbm5lckhUTUw9XCJcIiksUChcInRlbXBsYXRlXCI9PXQudHlwZT91LmNvbnRlbnQ6dSxkKHkpP3k6W3ldLHQsaSxyLFwiZm9yZWlnbk9iamVjdFwiPT14P1wiaHR0cDovL3d3dy53My5vcmcvMTk5OS94aHRtbFwiOm8sZSxmLGU/ZVswXTppLl9fayYmUyhpLDApLGMscyksbnVsbCE9ZSlmb3IoYT1lLmxlbmd0aDthLS07KWcoZVthXSk7Y3x8KGE9XCJ2YWx1ZVwiLFwicHJvZ3Jlc3NcIj09eCYmbnVsbD09Xz91LnJlbW92ZUF0dHJpYnV0ZShcInZhbHVlXCIpOm51bGwhPV8mJihfIT09dVthXXx8XCJwcm9ncmVzc1wiPT14JiYhX3x8XCJvcHRpb25cIj09eCYmXyE9YlthXSkmJkYodSxhLF8sYlthXSxvKSxhPVwiY2hlY2tlZFwiLG51bGwhPW0mJm0hPXVbYV0mJkYodSxhLG0sYlthXSxvKSl9cmV0dXJuIHV9ZnVuY3Rpb24gRChuLHUsdCl7dHJ5e2lmKFwiZnVuY3Rpb25cIj09dHlwZW9mIG4pe3ZhciBpPVwiZnVuY3Rpb25cIj09dHlwZW9mIG4uX191O2kmJm4uX191KCksaSYmbnVsbD09dXx8KG4uX191PW4odSkpfWVsc2Ugbi5jdXJyZW50PXV9Y2F0Y2gobil7bC5fX2Uobix0KX19ZnVuY3Rpb24gRShuLHUsdCl7dmFyIGkscjtpZihsLnVubW91bnQmJmwudW5tb3VudChuKSwoaT1uLnJlZikmJihpLmN1cnJlbnQmJmkuY3VycmVudCE9bi5fX2V8fEQoaSxudWxsLHUpKSxudWxsIT0oaT1uLl9fYykpe2lmKGkuY29tcG9uZW50V2lsbFVubW91bnQpdHJ5e2kuY29tcG9uZW50V2lsbFVubW91bnQoKX1jYXRjaChuKXtsLl9fZShuLHUpfWkuYmFzZT1pLl9fUD1udWxsfWlmKGk9bi5fX2spZm9yKHI9MDtyPGkubGVuZ3RoO3IrKylpW3JdJiZFKGlbcl0sdSx0fHxcImZ1bmN0aW9uXCIhPXR5cGVvZiBuLnR5cGUpO3R8fGcobi5fX2UpLG4uX19jPW4uX189bi5fX2U9dm9pZCAwfWZ1bmN0aW9uIEcobixsLHUpe3JldHVybiB0aGlzLmNvbnN0cnVjdG9yKG4sdSl9ZnVuY3Rpb24gSih1LHQsaSl7dmFyIHIsbyxlLGY7dD09ZG9jdW1lbnQmJih0PWRvY3VtZW50LmRvY3VtZW50RWxlbWVudCksbC5fXyYmbC5fXyh1LHQpLG89KHI9XCJmdW5jdGlvblwiPT10eXBlb2YgaSk/bnVsbDppJiZpLl9fa3x8dC5fX2ssZT1bXSxmPVtdLHoodCx1PSghciYmaXx8dCkuX19rPV8oayxudWxsLFt1XSksb3x8cCxwLHQubmFtZXNwYWNlVVJJLCFyJiZpP1tpXTpvP251bGw6dC5maXJzdENoaWxkP24uY2FsbCh0LmNoaWxkTm9kZXMpOm51bGwsZSwhciYmaT9pOm8/by5fX2U6dC5maXJzdENoaWxkLHIsZiksVihlLHUsZil9ZnVuY3Rpb24gSyhuLGwpe0oobixsLEspfWZ1bmN0aW9uIFEobCx1LHQpe3ZhciBpLHIsbyxlLGY9dyh7fSxsLnByb3BzKTtmb3IobyBpbiBsLnR5cGUmJmwudHlwZS5kZWZhdWx0UHJvcHMmJihlPWwudHlwZS5kZWZhdWx0UHJvcHMpLHUpXCJrZXlcIj09bz9pPXVbb106XCJyZWZcIj09bz9yPXVbb106ZltvXT12b2lkIDA9PT11W29dJiZudWxsIT1lP2Vbb106dVtvXTtyZXR1cm4gYXJndW1lbnRzLmxlbmd0aD4yJiYoZi5jaGlsZHJlbj1hcmd1bWVudHMubGVuZ3RoPjM/bi5jYWxsKGFyZ3VtZW50cywyKTp0KSxtKGwudHlwZSxmLGl8fGwua2V5LHJ8fGwucmVmLG51bGwpfWZ1bmN0aW9uIFIobil7ZnVuY3Rpb24gbChuKXt2YXIgdSx0O3JldHVybiB0aGlzLmdldENoaWxkQ29udGV4dHx8KHU9bmV3IFNldCwodD17fSlbbC5fX2NdPXRoaXMsdGhpcy5nZXRDaGlsZENvbnRleHQ9ZnVuY3Rpb24oKXtyZXR1cm4gdH0sdGhpcy5jb21wb25lbnRXaWxsVW5tb3VudD1mdW5jdGlvbigpe3U9bnVsbH0sdGhpcy5zaG91bGRDb21wb25lbnRVcGRhdGU9ZnVuY3Rpb24obil7dGhpcy5wcm9wcy52YWx1ZSE9bi52YWx1ZSYmdS5mb3JFYWNoKGZ1bmN0aW9uKG4pe24uX19lPSEwLCQobil9KX0sdGhpcy5zdWI9ZnVuY3Rpb24obil7dS5hZGQobik7dmFyIGw9bi5jb21wb25lbnRXaWxsVW5tb3VudDtuLmNvbXBvbmVudFdpbGxVbm1vdW50PWZ1bmN0aW9uKCl7dSYmdS5kZWxldGUobiksbCYmbC5jYWxsKG4pfX0pLG4uY2hpbGRyZW59cmV0dXJuIGwuX19jPVwiX19jQ1wiK2grKyxsLl9fPW4sbC5Qcm92aWRlcj1sLl9fbD0obC5Db25zdW1lcj1mdW5jdGlvbihuLGwpe3JldHVybiBuLmNoaWxkcmVuKGwpfSkuY29udGV4dFR5cGU9bCxsfW49di5zbGljZSxsPXtfX2U6ZnVuY3Rpb24obixsLHUsdCl7Zm9yKHZhciBpLHIsbztsPWwuX187KWlmKChpPWwuX19jKSYmIWkuX18pdHJ5e2lmKChyPWkuY29uc3RydWN0b3IpJiZudWxsIT1yLmdldERlcml2ZWRTdGF0ZUZyb21FcnJvciYmKGkuc2V0U3RhdGUoci5nZXREZXJpdmVkU3RhdGVGcm9tRXJyb3IobikpLG89aS5fX2QpLG51bGwhPWkuY29tcG9uZW50RGlkQ2F0Y2gmJihpLmNvbXBvbmVudERpZENhdGNoKG4sdHx8e30pLG89aS5fX2QpLG8pcmV0dXJuIGkuX19FPWl9Y2F0Y2gobCl7bj1sfXRocm93IG59fSx1PTAsdD1mdW5jdGlvbihuKXtyZXR1cm4gbnVsbCE9biYmdm9pZCAwPT09bi5jb25zdHJ1Y3Rvcn0seC5wcm90b3R5cGUuc2V0U3RhdGU9ZnVuY3Rpb24obixsKXt2YXIgdTt1PW51bGwhPXRoaXMuX19zJiZ0aGlzLl9fcyE9dGhpcy5zdGF0ZT90aGlzLl9fczp0aGlzLl9fcz13KHt9LHRoaXMuc3RhdGUpLFwiZnVuY3Rpb25cIj09dHlwZW9mIG4mJihuPW4odyh7fSx1KSx0aGlzLnByb3BzKSksbiYmdyh1LG4pLG51bGwhPW4mJnRoaXMuX192JiYobCYmdGhpcy5fc2IucHVzaChsKSwkKHRoaXMpKX0seC5wcm90b3R5cGUuZm9yY2VVcGRhdGU9ZnVuY3Rpb24obil7dGhpcy5fX3YmJih0aGlzLl9fZT0hMCxuJiZ0aGlzLl9faC5wdXNoKG4pLCQodGhpcykpfSx4LnByb3RvdHlwZS5yZW5kZXI9ayxpPVtdLG89XCJmdW5jdGlvblwiPT10eXBlb2YgUHJvbWlzZT9Qcm9taXNlLnByb3RvdHlwZS50aGVuLmJpbmQoUHJvbWlzZS5yZXNvbHZlKCkpOnNldFRpbWVvdXQsZT1mdW5jdGlvbihuLGwpe3JldHVybiBuLl9fdi5fX2ItbC5fX3YuX19ifSxJLl9fcj0wLGY9LyhQb2ludGVyQ2FwdHVyZSkkfENhcHR1cmUkL2ksYz0wLHM9TyghMSksYT1PKCEwKSxoPTA7ZXhwb3J0e3ggYXMgQ29tcG9uZW50LGsgYXMgRnJhZ21lbnQsUSBhcyBjbG9uZUVsZW1lbnQsUiBhcyBjcmVhdGVDb250ZXh0LF8gYXMgY3JlYXRlRWxlbWVudCxiIGFzIGNyZWF0ZVJlZixfIGFzIGgsSyBhcyBoeWRyYXRlLHQgYXMgaXNWYWxpZEVsZW1lbnQsbCBhcyBvcHRpb25zLEogYXMgcmVuZGVyLEwgYXMgdG9DaGlsZEFycmF5fTtcbi8vIyBzb3VyY2VNYXBwaW5nVVJMPXByZWFjdC5tb2R1bGUuanMubWFwXG4iLAogICAgImltcG9ydHtGcmFnbWVudCBhcyBuLG9wdGlvbnMgYXMgZSxDb21wb25lbnQgYXMgb31mcm9tXCJwcmVhY3RcIjtpbXBvcnRcInByZWFjdC9kZXZ0b29sc1wiO3ZhciB0PXt9O2Z1bmN0aW9uIHIoKXt0PXt9fWZ1bmN0aW9uIGEoZSl7cmV0dXJuIGUudHlwZT09PW4/XCJGcmFnbWVudFwiOlwiZnVuY3Rpb25cIj09dHlwZW9mIGUudHlwZT9lLnR5cGUuZGlzcGxheU5hbWV8fGUudHlwZS5uYW1lOlwic3RyaW5nXCI9PXR5cGVvZiBlLnR5cGU/ZS50eXBlOlwiI3RleHRcIn12YXIgaT1bXSxzPVtdO2Z1bmN0aW9uIGMoKXtyZXR1cm4gaS5sZW5ndGg+MD9pW2kubGVuZ3RoLTFdOm51bGx9dmFyIGw9ITA7ZnVuY3Rpb24gdShlKXtyZXR1cm5cImZ1bmN0aW9uXCI9PXR5cGVvZiBlLnR5cGUmJmUudHlwZSE9bn1mdW5jdGlvbiBmKG4pe2Zvcih2YXIgZT1bbl0sbz1uO251bGwhPW8uX19vOyllLnB1c2goby5fX28pLG89by5fX287cmV0dXJuIGUucmVkdWNlKGZ1bmN0aW9uKG4sZSl7bis9XCIgIGluIFwiK2EoZSk7dmFyIG89ZS5fX3NvdXJjZTtyZXR1cm4gbz9uKz1cIiAoYXQgXCIrby5maWxlTmFtZStcIjpcIitvLmxpbmVOdW1iZXIrXCIpXCI6bCYmY29uc29sZS53YXJuKFwiQWRkIEBiYWJlbC9wbHVnaW4tdHJhbnNmb3JtLXJlYWN0LWpzeC1zb3VyY2UgdG8gZ2V0IGEgbW9yZSBkZXRhaWxlZCBjb21wb25lbnQgc3RhY2suIE5vdGUgdGhhdCB5b3Ugc2hvdWxkIG5vdCBhZGQgaXQgdG8gcHJvZHVjdGlvbiBidWlsZHMgb2YgeW91ciBBcHAgZm9yIGJ1bmRsZSBzaXplIHJlYXNvbnMuXCIpLGw9ITEsbitcIlxcblwifSxcIlwiKX12YXIgZD1cImZ1bmN0aW9uXCI9PXR5cGVvZiBXZWFrTWFwO2Z1bmN0aW9uIHAobil7dmFyIGU9W107cmV0dXJuIG4uX19rPyhuLl9fay5mb3JFYWNoKGZ1bmN0aW9uKG4pe24mJlwiZnVuY3Rpb25cIj09dHlwZW9mIG4udHlwZT9lLnB1c2guYXBwbHkoZSxwKG4pKTpuJiZcInN0cmluZ1wiPT10eXBlb2Ygbi50eXBlJiZlLnB1c2gobi50eXBlKX0pLGUpOmV9ZnVuY3Rpb24gaChuKXtyZXR1cm4gbj9cImZ1bmN0aW9uXCI9PXR5cGVvZiBuLnR5cGU/bnVsbD09bi5fXz9udWxsIT1uLl9fZSYmbnVsbCE9bi5fX2UucGFyZW50Tm9kZT9uLl9fZS5wYXJlbnROb2RlLmxvY2FsTmFtZTpcIlwiOmgobi5fXyk6bi50eXBlOlwiXCJ9dmFyIHY9by5wcm90b3R5cGUuc2V0U3RhdGU7ZnVuY3Rpb24geShuKXtyZXR1cm5cInRhYmxlXCI9PT1ufHxcInRmb290XCI9PT1ufHxcInRib2R5XCI9PT1ufHxcInRoZWFkXCI9PT1ufHxcInRkXCI9PT1ufHxcInRyXCI9PT1ufHxcInRoXCI9PT1ufW8ucHJvdG90eXBlLnNldFN0YXRlPWZ1bmN0aW9uKG4sZSl7cmV0dXJuIG51bGw9PXRoaXMuX192JiZudWxsPT10aGlzLnN0YXRlJiZjb25zb2xlLndhcm4oJ0NhbGxpbmcgXCJ0aGlzLnNldFN0YXRlXCIgaW5zaWRlIHRoZSBjb25zdHJ1Y3RvciBvZiBhIGNvbXBvbmVudCBpcyBhIG5vLW9wIGFuZCBtaWdodCBiZSBhIGJ1ZyBpbiB5b3VyIGFwcGxpY2F0aW9uLiBJbnN0ZWFkLCBzZXQgXCJ0aGlzLnN0YXRlID0ge31cIiBkaXJlY3RseS5cXG5cXG4nK2YoYygpKSksdi5jYWxsKHRoaXMsbixlKX07dmFyIG09L14oYWRkcmVzc3xhcnRpY2xlfGFzaWRlfGJsb2NrcXVvdGV8ZGV0YWlsc3xkaXZ8ZGx8ZmllbGRzZXR8ZmlnY2FwdGlvbnxmaWd1cmV8Zm9vdGVyfGZvcm18aDF8aDJ8aDN8aDR8aDV8aDZ8aGVhZGVyfGhncm91cHxocnxtYWlufG1lbnV8bmF2fG9sfHB8cHJlfHNlYXJjaHxzZWN0aW9ufHRhYmxlfHVsKSQvLGI9by5wcm90b3R5cGUuZm9yY2VVcGRhdGU7ZnVuY3Rpb24gdyhuKXt2YXIgZT1uLnByb3BzLG89YShuKSx0PVwiXCI7Zm9yKHZhciByIGluIGUpaWYoZS5oYXNPd25Qcm9wZXJ0eShyKSYmXCJjaGlsZHJlblwiIT09cil7dmFyIGk9ZVtyXTtcImZ1bmN0aW9uXCI9PXR5cGVvZiBpJiYoaT1cImZ1bmN0aW9uIFwiKyhpLmRpc3BsYXlOYW1lfHxpLm5hbWUpK1wiKCkge31cIiksaT1PYmplY3QoaSkhPT1pfHxpLnRvU3RyaW5nP2krXCJcIjpPYmplY3QucHJvdG90eXBlLnRvU3RyaW5nLmNhbGwoaSksdCs9XCIgXCIrcitcIj1cIitKU09OLnN0cmluZ2lmeShpKX12YXIgcz1lLmNoaWxkcmVuO3JldHVyblwiPFwiK28rdCsocyYmcy5sZW5ndGg/XCI+Li48L1wiK28rXCI+XCI6XCIgLz5cIil9by5wcm90b3R5cGUuZm9yY2VVcGRhdGU9ZnVuY3Rpb24obil7cmV0dXJuIG51bGw9PXRoaXMuX192P2NvbnNvbGUud2FybignQ2FsbGluZyBcInRoaXMuZm9yY2VVcGRhdGVcIiBpbnNpZGUgdGhlIGNvbnN0cnVjdG9yIG9mIGEgY29tcG9uZW50IGlzIGEgbm8tb3AgYW5kIG1pZ2h0IGJlIGEgYnVnIGluIHlvdXIgYXBwbGljYXRpb24uXFxuXFxuJytmKGMoKSkpOm51bGw9PXRoaXMuX19QJiZjb25zb2xlLndhcm4oJ0NhblxcJ3QgY2FsbCBcInRoaXMuZm9yY2VVcGRhdGVcIiBvbiBhbiB1bm1vdW50ZWQgY29tcG9uZW50LiBUaGlzIGlzIGEgbm8tb3AsIGJ1dCBpdCBpbmRpY2F0ZXMgYSBtZW1vcnkgbGVhayBpbiB5b3VyIGFwcGxpY2F0aW9uLiBUbyBmaXgsIGNhbmNlbCBhbGwgc3Vic2NyaXB0aW9ucyBhbmQgYXN5bmNocm9ub3VzIHRhc2tzIGluIHRoZSBjb21wb25lbnRXaWxsVW5tb3VudCBtZXRob2QuXFxuXFxuJytmKHRoaXMuX192KSksYi5jYWxsKHRoaXMsbil9LGUuX19tPWZ1bmN0aW9uKG4sZSl7dmFyIG89bi50eXBlLHQ9ZS5tYXAoZnVuY3Rpb24obil7cmV0dXJuIG4mJm4ubG9jYWxOYW1lfSkuZmlsdGVyKEJvb2xlYW4pO2NvbnNvbGUuZXJyb3IoJ0V4cGVjdGVkIGEgRE9NIG5vZGUgb2YgdHlwZSBcIicrbysnXCIgYnV0IGZvdW5kIFwiJyt0LmpvaW4oXCIsIFwiKStcIlxcXCIgYXMgYXZhaWxhYmxlIERPTS1ub2RlKHMpLCB0aGlzIGlzIGNhdXNlZCBieSB0aGUgU1NSJ2QgSFRNTCBjb250YWluaW5nIGRpZmZlcmVudCBET00tbm9kZXMgY29tcGFyZWQgdG8gdGhlIGh5ZHJhdGVkIG9uZS5cXG5cXG5cIitmKG4pKX0sZnVuY3Rpb24oKXshZnVuY3Rpb24oKXt2YXIgbj1lLl9fYixvPWUuZGlmZmVkLHQ9ZS5fXyxyPWUudm5vZGUsYT1lLl9fcjtlLmRpZmZlZD1mdW5jdGlvbihuKXt1KG4pJiZzLnBvcCgpLGkucG9wKCksbyYmbyhuKX0sZS5fX2I9ZnVuY3Rpb24oZSl7dShlKSYmaS5wdXNoKGUpLG4mJm4oZSl9LGUuX189ZnVuY3Rpb24obixlKXtzPVtdLHQmJnQobixlKX0sZS52bm9kZT1mdW5jdGlvbihuKXtuLl9fbz1zLmxlbmd0aD4wP3Nbcy5sZW5ndGgtMV06bnVsbCxyJiZyKG4pfSxlLl9fcj1mdW5jdGlvbihuKXt1KG4pJiZzLnB1c2gobiksYSYmYShuKX19KCk7dmFyIG49ITEsbz1lLl9fYixyPWUuZGlmZmVkLGM9ZS52bm9kZSxsPWUuX19yLHY9ZS5fX2UsYj1lLl9fLGc9ZS5fX2gsRT1kP3t1c2VFZmZlY3Q6bmV3IFdlYWtNYXAsdXNlTGF5b3V0RWZmZWN0Om5ldyBXZWFrTWFwLGxhenlQcm9wVHlwZXM6bmV3IFdlYWtNYXB9Om51bGwsaz1bXTtlLl9fZT1mdW5jdGlvbihuLGUsbyx0KXtpZihlJiZlLl9fYyYmXCJmdW5jdGlvblwiPT10eXBlb2Ygbi50aGVuKXt2YXIgcj1uO249bmV3IEVycm9yKFwiTWlzc2luZyBTdXNwZW5zZS4gVGhlIHRocm93aW5nIGNvbXBvbmVudCB3YXM6IFwiK2EoZSkpO2Zvcih2YXIgaT1lO2k7aT1pLl9fKWlmKGkuX19jJiZpLl9fYy5fX2Mpe249cjticmVha31pZihuIGluc3RhbmNlb2YgRXJyb3IpdGhyb3cgbn10cnl7KHQ9dHx8e30pLmNvbXBvbmVudFN0YWNrPWYoZSksdihuLGUsbyx0KSxcImZ1bmN0aW9uXCIhPXR5cGVvZiBuLnRoZW4mJnNldFRpbWVvdXQoZnVuY3Rpb24oKXt0aHJvdyBufSl9Y2F0Y2gobil7dGhyb3cgbn19LGUuX189ZnVuY3Rpb24obixlKXtpZighZSl0aHJvdyBuZXcgRXJyb3IoXCJVbmRlZmluZWQgcGFyZW50IHBhc3NlZCB0byByZW5kZXIoKSwgdGhpcyBpcyB0aGUgc2Vjb25kIGFyZ3VtZW50LlxcbkNoZWNrIGlmIHRoZSBlbGVtZW50IGlzIGF2YWlsYWJsZSBpbiB0aGUgRE9NL2hhcyB0aGUgY29ycmVjdCBpZC5cIik7dmFyIG87c3dpdGNoKGUubm9kZVR5cGUpe2Nhc2UgMTpjYXNlIDExOmNhc2UgOTpvPSEwO2JyZWFrO2RlZmF1bHQ6bz0hMX1pZighbyl7dmFyIHQ9YShuKTt0aHJvdyBuZXcgRXJyb3IoXCJFeHBlY3RlZCBhIHZhbGlkIEhUTUwgbm9kZSBhcyBhIHNlY29uZCBhcmd1bWVudCB0byByZW5kZXIuXFx0UmVjZWl2ZWQgXCIrZStcIiBpbnN0ZWFkOiByZW5kZXIoPFwiK3QrXCIgLz4sIFwiK2UrXCIpO1wiKX1iJiZiKG4sZSl9LGUuX19iPWZ1bmN0aW9uKGUpe3ZhciByPWUudHlwZTtpZihuPSEwLHZvaWQgMD09PXIpdGhyb3cgbmV3IEVycm9yKFwiVW5kZWZpbmVkIGNvbXBvbmVudCBwYXNzZWQgdG8gY3JlYXRlRWxlbWVudCgpXFxuXFxuWW91IGxpa2VseSBmb3Jnb3QgdG8gZXhwb3J0IHlvdXIgY29tcG9uZW50IG9yIG1pZ2h0IGhhdmUgbWl4ZWQgdXAgZGVmYXVsdCBhbmQgbmFtZWQgaW1wb3J0c1wiK3coZSkrXCJcXG5cXG5cIitmKGUpKTtpZihudWxsIT1yJiZcIm9iamVjdFwiPT10eXBlb2Ygcil7aWYodm9pZCAwIT09ci5fX2smJnZvaWQgMCE9PXIuX19lKXRocm93IG5ldyBFcnJvcihcIkludmFsaWQgdHlwZSBwYXNzZWQgdG8gY3JlYXRlRWxlbWVudCgpOiBcIityK1wiXFxuXFxuRGlkIHlvdSBhY2NpZGVudGFsbHkgcGFzcyBhIEpTWCBsaXRlcmFsIGFzIEpTWCB0d2ljZT9cXG5cXG4gIGxldCBNeVwiK2EoZSkrXCIgPSBcIit3KHIpK1wiO1xcbiAgbGV0IHZub2RlID0gPE15XCIrYShlKStcIiAvPjtcXG5cXG5UaGlzIHVzdWFsbHkgaGFwcGVucyB3aGVuIHlvdSBleHBvcnQgYSBKU1ggbGl0ZXJhbCBhbmQgbm90IHRoZSBjb21wb25lbnQuXFxuXFxuXCIrZihlKSk7dGhyb3cgbmV3IEVycm9yKFwiSW52YWxpZCB0eXBlIHBhc3NlZCB0byBjcmVhdGVFbGVtZW50KCk6IFwiKyhBcnJheS5pc0FycmF5KHIpP1wiYXJyYXlcIjpyKSl9aWYodm9pZCAwIT09ZS5yZWYmJlwiZnVuY3Rpb25cIiE9dHlwZW9mIGUucmVmJiZcIm9iamVjdFwiIT10eXBlb2YgZS5yZWYmJiEoXCIkJHR5cGVvZlwiaW4gZSkpdGhyb3cgbmV3IEVycm9yKCdDb21wb25lbnRcXCdzIFwicmVmXCIgcHJvcGVydHkgc2hvdWxkIGJlIGEgZnVuY3Rpb24sIG9yIGFuIG9iamVjdCBjcmVhdGVkIGJ5IGNyZWF0ZVJlZigpLCBidXQgZ290IFsnK3R5cGVvZiBlLnJlZitcIl0gaW5zdGVhZFxcblwiK3coZSkrXCJcXG5cXG5cIitmKGUpKTtpZihcInN0cmluZ1wiPT10eXBlb2YgZS50eXBlKWZvcih2YXIgaSBpbiBlLnByb3BzKWlmKFwib1wiPT09aVswXSYmXCJuXCI9PT1pWzFdJiZcImZ1bmN0aW9uXCIhPXR5cGVvZiBlLnByb3BzW2ldJiZudWxsIT1lLnByb3BzW2ldKXRocm93IG5ldyBFcnJvcihcIkNvbXBvbmVudCdzIFxcXCJcIitpKydcIiBwcm9wZXJ0eSBzaG91bGQgYmUgYSBmdW5jdGlvbiwgYnV0IGdvdCBbJyt0eXBlb2YgZS5wcm9wc1tpXStcIl0gaW5zdGVhZFxcblwiK3coZSkrXCJcXG5cXG5cIitmKGUpKTtpZihcImZ1bmN0aW9uXCI9PXR5cGVvZiBlLnR5cGUmJmUudHlwZS5wcm9wVHlwZXMpe2lmKFwiTGF6eVwiPT09ZS50eXBlLmRpc3BsYXlOYW1lJiZFJiYhRS5sYXp5UHJvcFR5cGVzLmhhcyhlLnR5cGUpKXt2YXIgcz1cIlByb3BUeXBlcyBhcmUgbm90IHN1cHBvcnRlZCBvbiBsYXp5KCkuIFVzZSBwcm9wVHlwZXMgb24gdGhlIHdyYXBwZWQgY29tcG9uZW50IGl0c2VsZi4gXCI7dHJ5e3ZhciBjPWUudHlwZSgpO0UubGF6eVByb3BUeXBlcy5zZXQoZS50eXBlLCEwKSxjb25zb2xlLndhcm4ocytcIkNvbXBvbmVudCB3cmFwcGVkIGluIGxhenkoKSBpcyBcIithKGMpKX1jYXRjaChuKXtjb25zb2xlLndhcm4ocytcIldlIHdpbGwgbG9nIHRoZSB3cmFwcGVkIGNvbXBvbmVudCdzIG5hbWUgb25jZSBpdCBpcyBsb2FkZWQuXCIpfX12YXIgbD1lLnByb3BzO2UudHlwZS5fX2YmJmRlbGV0ZShsPWZ1bmN0aW9uKG4sZSl7Zm9yKHZhciBvIGluIGUpbltvXT1lW29dO3JldHVybiBufSh7fSxsKSkucmVmLGZ1bmN0aW9uKG4sZSxvLHIsYSl7T2JqZWN0LmtleXMobikuZm9yRWFjaChmdW5jdGlvbihvKXt2YXIgaTt0cnl7aT1uW29dKGUsbyxyLFwicHJvcFwiLG51bGwsXCJTRUNSRVRfRE9fTk9UX1BBU1NfVEhJU19PUl9ZT1VfV0lMTF9CRV9GSVJFRFwiKX1jYXRjaChuKXtpPW59aSYmIShpLm1lc3NhZ2UgaW4gdCkmJih0W2kubWVzc2FnZV09ITAsY29uc29sZS5lcnJvcihcIkZhaWxlZCBwcm9wIHR5cGU6IFwiK2kubWVzc2FnZSsoYSYmXCJcXG5cIithKCl8fFwiXCIpKSl9KX0oZS50eXBlLnByb3BUeXBlcyxsLDAsYShlKSxmdW5jdGlvbigpe3JldHVybiBmKGUpfSl9byYmbyhlKX07dmFyIFQsXz0wO2UuX19yPWZ1bmN0aW9uKGUpe2wmJmwoZSksbj0hMDt2YXIgbz1lLl9fYztpZihvPT09VD9fKys6Xz0xLF8+PTI1KXRocm93IG5ldyBFcnJvcihcIlRvbyBtYW55IHJlLXJlbmRlcnMuIFRoaXMgaXMgbGltaXRlZCB0byBwcmV2ZW50IGFuIGluZmluaXRlIGxvb3Agd2hpY2ggbWF5IGxvY2sgdXAgeW91ciBicm93c2VyLiBUaGUgY29tcG9uZW50IGNhdXNpbmcgdGhpcyBpczogXCIrYShlKSk7VD1vfSxlLl9faD1mdW5jdGlvbihlLG8sdCl7aWYoIWV8fCFuKXRocm93IG5ldyBFcnJvcihcIkhvb2sgY2FuIG9ubHkgYmUgaW52b2tlZCBmcm9tIHJlbmRlciBtZXRob2RzLlwiKTtnJiZnKGUsbyx0KX07dmFyIE89ZnVuY3Rpb24obixlKXtyZXR1cm57Z2V0OmZ1bmN0aW9uKCl7dmFyIG89XCJnZXRcIituK2U7ayYmay5pbmRleE9mKG8pPDAmJihrLnB1c2gobyksY29uc29sZS53YXJuKFwiZ2V0dGluZyB2bm9kZS5cIituK1wiIGlzIGRlcHJlY2F0ZWQsIFwiK2UpKX0sc2V0OmZ1bmN0aW9uKCl7dmFyIG89XCJzZXRcIituK2U7ayYmay5pbmRleE9mKG8pPDAmJihrLnB1c2gobyksY29uc29sZS53YXJuKFwic2V0dGluZyB2bm9kZS5cIituK1wiIGlzIG5vdCBhbGxvd2VkLCBcIitlKSl9fX0sST17bm9kZU5hbWU6TyhcIm5vZGVOYW1lXCIsXCJ1c2Ugdm5vZGUudHlwZVwiKSxhdHRyaWJ1dGVzOk8oXCJhdHRyaWJ1dGVzXCIsXCJ1c2Ugdm5vZGUucHJvcHNcIiksY2hpbGRyZW46TyhcImNoaWxkcmVuXCIsXCJ1c2Ugdm5vZGUucHJvcHMuY2hpbGRyZW5cIil9LE09T2JqZWN0LmNyZWF0ZSh7fSxJKTtlLnZub2RlPWZ1bmN0aW9uKG4pe3ZhciBlPW4ucHJvcHM7aWYobnVsbCE9PW4udHlwZSYmbnVsbCE9ZSYmKFwiX19zb3VyY2VcImluIGV8fFwiX19zZWxmXCJpbiBlKSl7dmFyIG89bi5wcm9wcz17fTtmb3IodmFyIHQgaW4gZSl7dmFyIHI9ZVt0XTtcIl9fc291cmNlXCI9PT10P24uX19zb3VyY2U9cjpcIl9fc2VsZlwiPT09dD9uLl9fc2VsZj1yOm9bdF09cn19bi5fX3Byb3RvX189TSxjJiZjKG4pfSxlLmRpZmZlZD1mdW5jdGlvbihlKXt2YXIgbyx0PWUudHlwZSxpPWUuX187aWYoZS5fX2smJmUuX19rLmZvckVhY2goZnVuY3Rpb24obil7aWYoXCJvYmplY3RcIj09dHlwZW9mIG4mJm4mJnZvaWQgMD09PW4udHlwZSl7dmFyIG89T2JqZWN0LmtleXMobikuam9pbihcIixcIik7dGhyb3cgbmV3IEVycm9yKFwiT2JqZWN0cyBhcmUgbm90IHZhbGlkIGFzIGEgY2hpbGQuIEVuY291bnRlcmVkIGFuIG9iamVjdCB3aXRoIHRoZSBrZXlzIHtcIitvK1wifS5cXG5cXG5cIitmKGUpKX19KSxlLl9fYz09PVQmJihfPTApLFwic3RyaW5nXCI9PXR5cGVvZiB0JiYoeSh0KXx8XCJwXCI9PT10fHxcImFcIj09PXR8fFwiYnV0dG9uXCI9PT10KSl7dmFyIHM9aChpKTtpZihcIlwiIT09cyYmeSh0KSlcInRhYmxlXCI9PT10JiZcInRkXCIhPT1zJiZ5KHMpP2NvbnNvbGUuZXJyb3IoXCJJbXByb3BlciBuZXN0aW5nIG9mIHRhYmxlLiBZb3VyIDx0YWJsZT4gc2hvdWxkIG5vdCBoYXZlIGEgdGFibGUtbm9kZSBwYXJlbnQuXCIrdyhlKStcIlxcblxcblwiK2YoZSkpOlwidGhlYWRcIiE9PXQmJlwidGZvb3RcIiE9PXQmJlwidGJvZHlcIiE9PXR8fFwidGFibGVcIj09PXM/XCJ0clwiPT09dCYmXCJ0aGVhZFwiIT09cyYmXCJ0Zm9vdFwiIT09cyYmXCJ0Ym9keVwiIT09cz9jb25zb2xlLmVycm9yKFwiSW1wcm9wZXIgbmVzdGluZyBvZiB0YWJsZS4gWW91ciA8dHI+IHNob3VsZCBoYXZlIGEgPHRoZWFkL3Rib2R5L3Rmb290PiBwYXJlbnQuXCIrdyhlKStcIlxcblxcblwiK2YoZSkpOlwidGRcIj09PXQmJlwidHJcIiE9PXM/Y29uc29sZS5lcnJvcihcIkltcHJvcGVyIG5lc3Rpbmcgb2YgdGFibGUuIFlvdXIgPHRkPiBzaG91bGQgaGF2ZSBhIDx0cj4gcGFyZW50LlwiK3coZSkrXCJcXG5cXG5cIitmKGUpKTpcInRoXCI9PT10JiZcInRyXCIhPT1zJiZjb25zb2xlLmVycm9yKFwiSW1wcm9wZXIgbmVzdGluZyBvZiB0YWJsZS4gWW91ciA8dGg+IHNob3VsZCBoYXZlIGEgPHRyPi5cIit3KGUpK1wiXFxuXFxuXCIrZihlKSk6Y29uc29sZS5lcnJvcihcIkltcHJvcGVyIG5lc3Rpbmcgb2YgdGFibGUuIFlvdXIgPHRoZWFkL3Rib2R5L3Rmb290PiBzaG91bGQgaGF2ZSBhIDx0YWJsZT4gcGFyZW50LlwiK3coZSkrXCJcXG5cXG5cIitmKGUpKTtlbHNlIGlmKFwicFwiPT09dCl7dmFyIGM9cChlKS5maWx0ZXIoZnVuY3Rpb24obil7cmV0dXJuIG0udGVzdChuKX0pO2MubGVuZ3RoJiZjb25zb2xlLmVycm9yKFwiSW1wcm9wZXIgbmVzdGluZyBvZiBwYXJhZ3JhcGguIFlvdXIgPHA+IHNob3VsZCBub3QgaGF2ZSBcIitjLmpvaW4oXCIsIFwiKStcIiBhcyBjaGlsZC1lbGVtZW50cy5cIit3KGUpK1wiXFxuXFxuXCIrZihlKSl9ZWxzZVwiYVwiIT09dCYmXCJidXR0b25cIiE9PXR8fC0xIT09cChlKS5pbmRleE9mKHQpJiZjb25zb2xlLmVycm9yKFwiSW1wcm9wZXIgbmVzdGluZyBvZiBpbnRlcmFjdGl2ZSBjb250ZW50LiBZb3VyIDxcIit0K1wiPiBzaG91bGQgbm90IGhhdmUgb3RoZXIgXCIrKFwiYVwiPT09dD9cImFuY2hvclwiOlwiYnV0dG9uXCIpK1wiIHRhZ3MgYXMgY2hpbGQtZWxlbWVudHMuXCIrdyhlKStcIlxcblxcblwiK2YoZSkpfWlmKG49ITEsciYmcihlKSxudWxsIT1lLl9faylmb3IodmFyIGw9W10sdT0wO3U8ZS5fX2subGVuZ3RoO3UrKyl7dmFyIGQ9ZS5fX2tbdV07aWYoZCYmbnVsbCE9ZC5rZXkpe3ZhciB2PWQua2V5O2lmKC0xIT09bC5pbmRleE9mKHYpKXtjb25zb2xlLmVycm9yKCdGb2xsb3dpbmcgY29tcG9uZW50IGhhcyB0d28gb3IgbW9yZSBjaGlsZHJlbiB3aXRoIHRoZSBzYW1lIGtleSBhdHRyaWJ1dGU6IFwiJyt2KydcIi4gVGhpcyBtYXkgY2F1c2UgZ2xpdGNoZXMgYW5kIG1pc2JlaGF2aW9yIGluIHJlbmRlcmluZyBwcm9jZXNzLiBDb21wb25lbnQ6IFxcblxcbicrdyhlKStcIlxcblxcblwiK2YoZSkpO2JyZWFrfWwucHVzaCh2KX19aWYobnVsbCE9ZS5fX2MmJm51bGwhPWUuX19jLl9fSCl7dmFyIGI9ZS5fX2MuX19ILl9fO2lmKGIpZm9yKHZhciBnPTA7ZzxiLmxlbmd0aDtnKz0xKXt2YXIgRT1iW2ddO2lmKEUuX19IKWZvcih2YXIgaz0wO2s8RS5fX0gubGVuZ3RoO2srKylpZigobz1FLl9fSFtrXSkhPW8pe3ZhciBPPWEoZSk7Y29uc29sZS53YXJuKFwiSW52YWxpZCBhcmd1bWVudCBwYXNzZWQgdG8gaG9vay4gSG9va3Mgc2hvdWxkIG5vdCBiZSBjYWxsZWQgd2l0aCBOYU4gaW4gdGhlIGRlcGVuZGVuY3kgYXJyYXkuIEhvb2sgaW5kZXggXCIrZytcIiBpbiBjb21wb25lbnQgXCIrTytcIiB3YXMgY2FsbGVkIHdpdGggTmFOLlwiKX19fX19KCk7ZXhwb3J0e2MgYXMgZ2V0Q3VycmVudFZOb2RlLGEgYXMgZ2V0RGlzcGxheU5hbWUsZiBhcyBnZXRPd25lclN0YWNrLHIgYXMgcmVzZXRQcm9wV2FybmluZ3N9O1xuLy8jIHNvdXJjZU1hcHBpbmdVUkw9ZGVidWcubW9kdWxlLmpzLm1hcFxuIiwKICAgICJpbXBvcnR7b3B0aW9ucyBhcyBuLEZyYWdtZW50IGFzIG8sQ29tcG9uZW50IGFzIGV9ZnJvbVwicHJlYWN0XCI7dmFyIGk7ZnVuY3Rpb24gdChvLGUpe3JldHVybiBuLl9fYSYmbi5fX2EoZSksb31udWxsIT0oaT1cInVuZGVmaW5lZFwiIT10eXBlb2YgZ2xvYmFsVGhpcz9nbG9iYWxUaGlzOlwidW5kZWZpbmVkXCIhPXR5cGVvZiB3aW5kb3c/d2luZG93OnZvaWQgMCkmJmkuX19QUkVBQ1RfREVWVE9PTFNfXyYmaS5fX1BSRUFDVF9ERVZUT09MU19fLmF0dGFjaFByZWFjdChcIjEwLjI5LjBcIixuLHtGcmFnbWVudDpvLENvbXBvbmVudDplfSk7ZXhwb3J0e3QgYXMgYWRkSG9va05hbWV9O1xuLy8jIHNvdXJjZU1hcHBpbmdVUkw9ZGV2dG9vbHMubW9kdWxlLmpzLm1hcFxuIiwKICAgICIvKipcbiAqIFNpZ25hbHMgVGVzdCBQYWdlIOKAlCBpc29sYXRlZCBzYW5kYm94IHRvIHZhbGlkYXRlIEBwcmVhY3Qvc2lnbmFscyBwYXR0ZXJuc1xuICogYmVmb3JlIGFwcGx5aW5nIHRoZW0gdG8gdGhlIHByb2R1Y3Rpb24gYXBwLlxuICpcbiAqIFRlc3RzOlxuICogMS4gQXV0by1zdWJzY3JpYmU6IHNpZ25hbC52YWx1ZSBpbiBKU1gg4oaSIHJlLXJlbmRlciBvbiBjaGFuZ2U/XG4gKiAyLiB1c2VTaWduYWxFZmZlY3QgYnJpZGdlOiBzaWduYWwg4oaSIHVzZVN0YXRlIOKGkiByZS1yZW5kZXJcbiAqIDMuIGNyZWF0ZU1vZGVsICsgdXNlTW9kZWwgbGlmZWN5Y2xlXG4gKiA0LiBNb2RhbCBwYXR0ZXJuOiBjb25kaXRpb25hbCByZW5kZXIgYmFzZWQgb24gc2lnbmFsICh0aGUgYnJva2VuIGNhc2UpXG4gKiA1LiBDb21wdXRlZCBzaWduYWxzXG4gKiA2LiBhY3Rpb24oKSBiYXRjaGluZ1xuICovXG5pbXBvcnQgXCJwcmVhY3QvZGVidWdcIjsgLy8gTXVzdCBiZSBmaXJzdCDigJQgZW5hYmxlcyBQcmVhY3QgRGV2VG9vbHMgKyB3YXJuaW5nc1xuaW1wb3J0IHsgcmVuZGVyIH0gZnJvbSBcInByZWFjdFwiO1xuaW1wb3J0IHsgdXNlU3RhdGUgfSBmcm9tIFwicHJlYWN0L2hvb2tzXCI7XG5pbXBvcnQgXCJAcHJlYWN0L3NpZ25hbHNcIjsgLy8gc2lkZS1lZmZlY3Q6IGluc3RhbGwgb3B0aW9ucyBob29rc1xuaW1wb3J0IHtcbiAgc2lnbmFsLFxuICBjb21wdXRlZCxcbiAgZWZmZWN0LFxuICBhY3Rpb24sXG4gIGJhdGNoLFxuICBjcmVhdGVNb2RlbCxcbiAgdXNlTW9kZWwsXG4gIHVzZVNpZ25hbCxcbiAgdXNlU2lnbmFsRWZmZWN0LFxuICB1c2VDb21wdXRlZCxcbn0gZnJvbSBcIkBwcmVhY3Qvc2lnbmFsc1wiO1xuaW1wb3J0IHsgU2hvdywgRm9yIH0gZnJvbSBcIkBwcmVhY3Qvc2lnbmFscy91dGlsc1wiO1xuXG4vLyDilIDilIDilIAgVGVzdCBpbmZyYXN0cnVjdHVyZSDilIDilIDilIBcbmNvbnN0IHJlc3VsdHMgPSBzaWduYWw8QXJyYXk8eyBuYW1lOiBzdHJpbmc7IHBhc3M6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH0+PihbXSk7XG5cbmZ1bmN0aW9uIGxvZyhuYW1lOiBzdHJpbmcsIHBhc3M6IGJvb2xlYW4sIGRldGFpbCA9IFwiXCIpIHtcbiAgcmVzdWx0cy52YWx1ZSA9IFsuLi5yZXN1bHRzLnZhbHVlLCB7IG5hbWUsIHBhc3MsIGRldGFpbCB9XTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgMTogQXV0by1zdWJzY3JpYmUg4pSA4pSA4pSAXG5jb25zdCBhdXRvQ291bnQgPSBzaWduYWwoMCk7XG5sZXQgdDFSZW5kZXJzID0gMDtcblxuZnVuY3Rpb24gVGVzdDFfQXV0b1N1YnNjcmliZSgpIHtcbiAgdDFSZW5kZXJzKys7XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCAxOiBBdXRvLXN1YnNjcmliZTwvaDM+XG4gICAgICA8cD5cbiAgICAgICAgc2lnbmFsLnZhbHVlIGluIEpTWDogPHN0cm9uZz57YXV0b0NvdW50LnZhbHVlfTwvc3Ryb25nPlxuICAgICAgPC9wPlxuICAgICAgPHAgY2xhc3M9XCJkaW1cIj5Db21wb25lbnQgcmVuZGVyczoge3QxUmVuZGVyc308L3A+XG4gICAgICA8YnV0dG9uXG4gICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICBhdXRvQ291bnQudmFsdWUrKztcbiAgICAgICAgfX1cbiAgICAgID5cbiAgICAgICAgSW5jcmVtZW50XG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBJZiB0aGUgbnVtYmVyIHVwZGF0ZXMgd2hlbiB5b3UgY2xpY2ssIGF1dG8tc3Vic2NyaWJlIHdvcmtzIHdpdGggQnVuJ3NcbiAgICAgICAgYnVuZGxlci5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgMjogdXNlU2lnbmFsRWZmZWN0IGJyaWRnZSDilIDilIDilIBcbmNvbnN0IGJyaWRnZVNpZ25hbCA9IHNpZ25hbCgwKTtcblxuZnVuY3Rpb24gVGVzdDJfQnJpZGdlKCkge1xuICBjb25zdCBbbG9jYWwsIHNldExvY2FsXSA9IHVzZVN0YXRlKGJyaWRnZVNpZ25hbC52YWx1ZSk7XG4gIHVzZVNpZ25hbEVmZmVjdCgoKSA9PiB7XG4gICAgc2V0TG9jYWwoYnJpZGdlU2lnbmFsLnZhbHVlKTtcbiAgfSk7XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCAyOiB1c2VTaWduYWxFZmZlY3QgYnJpZGdlPC9oMz5cbiAgICAgIDxwPlxuICAgICAgICBTaWduYWw6IDxzdHJvbmcgaWQ9XCJ0Mi1zaWduYWxcIj57YnJpZGdlU2lnbmFsLnZhbHVlfTwvc3Ryb25nPiB8IExvY2FsXG4gICAgICAgIHN0YXRlOiA8c3Ryb25nIGlkPVwidDItbG9jYWxcIj57bG9jYWx9PC9zdHJvbmc+XG4gICAgICA8L3A+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgYnJpZGdlU2lnbmFsLnZhbHVlKys7IH19PlxuICAgICAgICBJbmNyZW1lbnQgc2lnbmFsXG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBCb3RoIG51bWJlcnMgc2hvdWxkIHVwZGF0ZSB0b2dldGhlci4gSWYgb25seSBcIlNpZ25hbFwiIHVwZGF0ZXMsIGF1dG8tc3Vic2NyaWJlIHdvcmtzXG4gICAgICAgIGJ1dCBicmlkZ2UgaXMgcmVkdW5kYW50LiBJZiBuZWl0aGVyIHVwZGF0ZXMsIGJvdGggYXJlIGJyb2tlbi5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgMzogY3JlYXRlTW9kZWwgKyB1c2VNb2RlbCDilIDilIDilIBcbmNvbnN0IENvdW50ZXJNb2RlbCA9IGNyZWF0ZU1vZGVsKCgpID0+IHtcbiAgY29uc3QgY291bnQgPSBzaWduYWwoMCk7XG4gIGNvbnN0IGRvdWJsZWQgPSBjb21wdXRlZCgoKSA9PiBjb3VudC52YWx1ZSAqIDIpO1xuICBjb25zdCBpbmNyZW1lbnQgPSBhY3Rpb24oKCkgPT4geyBjb3VudC52YWx1ZSsrOyB9KTtcbiAgY29uc3QgcmVzZXQgPSBhY3Rpb24oKCkgPT4geyBjb3VudC52YWx1ZSA9IDA7IH0pO1xuICByZXR1cm4geyBjb3VudCwgZG91YmxlZCwgaW5jcmVtZW50LCByZXNldCB9O1xufSk7XG5cbmZ1bmN0aW9uIFRlc3QzX01vZGVsKCkge1xuICBjb25zdCBtID0gdXNlTW9kZWwoQ291bnRlck1vZGVsKTtcbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCAzOiBjcmVhdGVNb2RlbCArIHVzZU1vZGVsPC9oMz5cbiAgICAgIDxwPlxuICAgICAgICBDb3VudDogPHN0cm9uZz57bS5jb3VudC52YWx1ZX08L3N0cm9uZz4gfCBEb3VibGVkOntcIiBcIn1cbiAgICAgICAgPHN0cm9uZz57bS5kb3VibGVkLnZhbHVlfTwvc3Ryb25nPlxuICAgICAgPC9wPlxuICAgICAgPGJ1dHRvbiBvbkNsaWNrPXttLmluY3JlbWVudH0+KzE8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gb25DbGljaz17bS5yZXNldH0+UmVzZXQ8L2J1dHRvbj5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBUZXN0cyBtb2RlbCBjcmVhdGlvbiwgY29tcHV0ZWQgZGVyaXZhdGlvbiwgYW5kIGFjdGlvbiBiYXRjaGluZy5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgNDogTW9kYWwgcGF0dGVybiAoVEhFIGJyb2tlbiBjYXNlKSDilIDilIDilIBcbmNvbnN0IG1vZGFsRXZlbnQgPSBzaWduYWw8eyBpZDogbnVtYmVyOyBuYW1lOiBzdHJpbmcgfSB8IG51bGw+KG51bGwpO1xuXG5mdW5jdGlvbiBUZXN0NF9Nb2RhbCgpIHtcbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCA0OiBNb2RhbCAoY29uZGl0aW9uYWwgcmVuZGVyIGZyb20gc2lnbmFsKTwvaDM+XG4gICAgICA8YnV0dG9uXG4gICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICBtb2RhbEV2ZW50LnZhbHVlID0geyBpZDogMSwgbmFtZTogXCJDYXQgZGV0ZWN0ZWQhXCIgfTtcbiAgICAgICAgfX1cbiAgICAgID5cbiAgICAgICAgT3BlbiBNb2RhbFxuICAgICAgPC9idXR0b24+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgbW9kYWxFdmVudC52YWx1ZSA9IG51bGw7IH19PlxuICAgICAgICBDbG9zZSBNb2RhbFxuICAgICAgPC9idXR0b24+XG4gICAgICA8cD5cbiAgICAgICAgbW9kYWxFdmVudDogPGNvZGU+e0pTT04uc3RyaW5naWZ5KG1vZGFsRXZlbnQudmFsdWUpfTwvY29kZT5cbiAgICAgIDwvcD5cbiAgICAgIHttb2RhbEV2ZW50LnZhbHVlICYmIChcbiAgICAgICAgPGRpdiBjbGFzcz1cIm1vY2stbW9kYWxcIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbC1jb250ZW50XCI+XG4gICAgICAgICAgICA8c3Ryb25nPk1vZGFsIE9wZW4hPC9zdHJvbmc+XG4gICAgICAgICAgICA8cD5FdmVudDoge21vZGFsRXZlbnQudmFsdWUubmFtZX0gKGlkPXttb2RhbEV2ZW50LnZhbHVlLmlkfSk8L3A+XG4gICAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgbW9kYWxFdmVudC52YWx1ZSA9IG51bGw7IH19PsOXPC9idXR0b24+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgKX1cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBJZiB0aGUgbW9kYWwgZG9lcyBOT1QgYXBwZWFyIHdoZW4gY2xpY2tpbmcgXCJPcGVuIE1vZGFsXCIsIGF1dG8tc3Vic2NyaWJlXG4gICAgICAgIGlzIGJyb2tlbiBhbmQgdGhlIGNvbXBvbmVudCBkb2Vzbid0IHJlLXJlbmRlciBvbiBzaWduYWwgY2hhbmdlLlxuICAgICAgPC9wPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG4vLyDilIDilIDilIAgVGVzdCA0YjogTW9kYWwgd2l0aCB1c2VTaWduYWxFZmZlY3QgYnJpZGdlICh3b3JrYXJvdW5kKSDilIDilIDilIBcbmZ1bmN0aW9uIFRlc3Q0Yl9Nb2RhbEJyaWRnZSgpIHtcbiAgY29uc3QgW2V2LCBzZXRFdl0gPSB1c2VTdGF0ZShtb2RhbEV2ZW50LnZhbHVlKTtcbiAgdXNlU2lnbmFsRWZmZWN0KCgpID0+IHtcbiAgICBzZXRFdihtb2RhbEV2ZW50LnZhbHVlKTtcbiAgfSk7XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCA0YjogTW9kYWwgKGJyaWRnZSB3b3JrYXJvdW5kKTwvaDM+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgbW9kYWxFdmVudC52YWx1ZSA9IHsgaWQ6IDIsIG5hbWU6IFwiRG9nIGRldGVjdGVkIVwiIH07IH19PlxuICAgICAgICBPcGVuIE1vZGFsXG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBtb2RhbEV2ZW50LnZhbHVlID0gbnVsbDsgfX0+Q2xvc2U8L2J1dHRvbj5cbiAgICAgIDxwPlxuICAgICAgICBsb2NhbCBldjogPGNvZGU+e0pTT04uc3RyaW5naWZ5KGV2KX08L2NvZGU+XG4gICAgICA8L3A+XG4gICAgICB7ZXYgJiYgKFxuICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbFwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJtb2NrLW1vZGFsLWNvbnRlbnRcIj5cbiAgICAgICAgICAgIDxzdHJvbmc+QnJpZGdlIE1vZGFsIE9wZW4hPC9zdHJvbmc+XG4gICAgICAgICAgICA8cD5FdmVudDoge2V2Lm5hbWV9IChpZD17ZXYuaWR9KTwvcD5cbiAgICAgICAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBtb2RhbEV2ZW50LnZhbHVlID0gbnVsbDsgfX0+w5c8L2J1dHRvbj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+XG4gICAgICApfVxuICAgICAgPHAgY2xhc3M9XCJoaW50XCI+U2FtZSBtb2RhbCBidXQgdXNpbmcgdXNlU2lnbmFsRWZmZWN04oaSdXNlU3RhdGUgYnJpZGdlLjwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgNTogdXNlTW9kZWwgbW9kYWwgcGF0dGVybiAobWltaWNzIHByb2R1Y3Rpb24gYXBwLnRzeCkg4pSA4pSA4pSAXG5jb25zdCBNb2RhbFN0b3JlID0gY3JlYXRlTW9kZWwoKCkgPT4ge1xuICBjb25zdCBzZWxlY3RlZCA9IHNpZ25hbDx7IGlkOiBudW1iZXI7IG5hbWU6IHN0cmluZyB9IHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IGl0ZW1zID0gc2lnbmFsKFtcbiAgICB7IGlkOiAxLCBuYW1lOiBcIkNoYXRvcmEgc2xlZXBpbmdcIiB9LFxuICAgIHsgaWQ6IDIsIG5hbWU6IFwiTWlrZSBlYXRpbmdcIiB9LFxuICAgIHsgaWQ6IDMsIG5hbWU6IFwiS2lqaXRvcmEgcGxheWluZ1wiIH0sXG4gIF0pO1xuICBjb25zdCBvcGVuTW9kYWwgPSBhY3Rpb24oKGl0ZW06IHsgaWQ6IG51bWJlcjsgbmFtZTogc3RyaW5nIH0pID0+IHtcbiAgICBzZWxlY3RlZC52YWx1ZSA9IGl0ZW07XG4gIH0pO1xuICBjb25zdCBjbG9zZU1vZGFsID0gYWN0aW9uKCgpID0+IHtcbiAgICBzZWxlY3RlZC52YWx1ZSA9IG51bGw7XG4gIH0pO1xuICByZXR1cm4geyBzZWxlY3RlZCwgaXRlbXMsIG9wZW5Nb2RhbCwgY2xvc2VNb2RhbCB9O1xufSk7XG5cbmZ1bmN0aW9uIFRlc3Q1X1N0b3JlTW9kYWwoKSB7XG4gIGNvbnN0IHN0b3JlID0gdXNlTW9kZWwoTW9kYWxTdG9yZSk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgNTogdXNlTW9kZWwgKyBtb2RhbCAocHJvZHVjdGlvbiBwYXR0ZXJuKTwvaDM+XG4gICAgICA8ZGl2IGNsYXNzPVwiaXRlbS1saXN0XCI+XG4gICAgICAgIHtzdG9yZS5pdGVtcy52YWx1ZS5tYXAoKGl0ZW0pID0+IChcbiAgICAgICAgICA8YnV0dG9uIGtleT17aXRlbS5pZH0gb25DbGljaz17KCkgPT4gc3RvcmUub3Blbk1vZGFsKGl0ZW0pfT5cbiAgICAgICAgICAgIHtpdGVtLm5hbWV9XG4gICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICkpfVxuICAgICAgPC9kaXY+XG4gICAgICA8cD5cbiAgICAgICAgc2VsZWN0ZWQ6IDxjb2RlPntKU09OLnN0cmluZ2lmeShzdG9yZS5zZWxlY3RlZC52YWx1ZSl9PC9jb2RlPlxuICAgICAgPC9wPlxuICAgICAge3N0b3JlLnNlbGVjdGVkLnZhbHVlICYmIChcbiAgICAgICAgPGRpdiBjbGFzcz1cIm1vY2stbW9kYWxcIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbC1jb250ZW50XCI+XG4gICAgICAgICAgICA8c3Ryb25nPntzdG9yZS5zZWxlY3RlZC52YWx1ZS5uYW1lfTwvc3Ryb25nPlxuICAgICAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXtzdG9yZS5jbG9zZU1vZGFsfT7DlzwvYnV0dG9uPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICAgICl9XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5cbiAgICAgICAgVGhpcyBpcyB0aGUgZXhhY3QgcGF0dGVybiBmcm9tIGFwcC50c3guIElmIHRoZSBtb2RhbCBkb2Vzbid0IGFwcGVhcixcbiAgICAgICAgY3JlYXRlTW9kZWwgKyBhdXRvLXN1YnNjcmliZSBpcyB0aGUgcHJvYmxlbS5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgNWI6IHVzZU1vZGVsICsgYnJpZGdlIOKUgOKUgOKUgFxuZnVuY3Rpb24gVGVzdDViX1N0b3JlTW9kYWxCcmlkZ2UoKSB7XG4gIGNvbnN0IHN0b3JlID0gdXNlTW9kZWwoTW9kYWxTdG9yZSk7XG4gIGNvbnN0IFtzZWwsIHNldFNlbF0gPSB1c2VTdGF0ZShzdG9yZS5zZWxlY3RlZC52YWx1ZSk7XG4gIHVzZVNpZ25hbEVmZmVjdCgoKSA9PiB7XG4gICAgc2V0U2VsKHN0b3JlLnNlbGVjdGVkLnZhbHVlKTtcbiAgfSk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgNWI6IHVzZU1vZGVsICsgYnJpZGdlIG1vZGFsPC9oMz5cbiAgICAgIDxkaXYgY2xhc3M9XCJpdGVtLWxpc3RcIj5cbiAgICAgICAge3N0b3JlLml0ZW1zLnZhbHVlLm1hcCgoaXRlbSkgPT4gKFxuICAgICAgICAgIDxidXR0b24ga2V5PXtpdGVtLmlkfSBvbkNsaWNrPXsoKSA9PiBzdG9yZS5vcGVuTW9kYWwoaXRlbSl9PlxuICAgICAgICAgICAge2l0ZW0ubmFtZX1cbiAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgKSl9XG4gICAgICA8L2Rpdj5cbiAgICAgIDxwPlxuICAgICAgICBsb2NhbCBzZWw6IDxjb2RlPntKU09OLnN0cmluZ2lmeShzZWwpfTwvY29kZT5cbiAgICAgIDwvcD5cbiAgICAgIHtzZWwgJiYgKFxuICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbFwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJtb2NrLW1vZGFsLWNvbnRlbnRcIj5cbiAgICAgICAgICAgIDxzdHJvbmc+e3NlbC5uYW1lfTwvc3Ryb25nPlxuICAgICAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXtzdG9yZS5jbG9zZU1vZGFsfT7DlzwvYnV0dG9uPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICAgICl9XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5TYW1lIGJ1dCB3aXRoIHVzZVNpZ25hbEVmZmVjdCBicmlkZ2UuPC9wPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG4vLyDilIDilIDilIAgVGVzdCA2OiB1c2VTaWduYWwgKGxvY2FsIHNpZ25hbCkg4pSA4pSA4pSAXG5mdW5jdGlvbiBUZXN0Nl9Vc2VTaWduYWwoKSB7XG4gIGNvbnN0IGNvdW50ID0gdXNlU2lnbmFsKDApO1xuICByZXR1cm4gKFxuICAgIDxkaXYgY2xhc3M9XCJ0ZXN0LWNhcmRcIj5cbiAgICAgIDxoMz5UZXN0IDY6IHVzZVNpZ25hbCAoY29tcG9uZW50LWxvY2FsKTwvaDM+XG4gICAgICA8cD5cbiAgICAgICAgQ291bnQ6IDxzdHJvbmc+e2NvdW50LnZhbHVlfTwvc3Ryb25nPlxuICAgICAgPC9wPlxuICAgICAgPGJ1dHRvbiBvbkNsaWNrPXsoKSA9PiB7IGNvdW50LnZhbHVlKys7IH19PisxPC9idXR0b24+XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj51c2VTaWduYWwgY3JlYXRlcyBhIGNvbXBvbmVudC1zY29wZWQgc2lnbmFsLjwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgNzogdXNlQ29tcHV0ZWQg4pSA4pSA4pSAXG5mdW5jdGlvbiBUZXN0N19Vc2VDb21wdXRlZCgpIHtcbiAgY29uc3QgY291bnQgPSB1c2VTaWduYWwoMCk7XG4gIGNvbnN0IGxhYmVsID0gdXNlQ29tcHV0ZWQoKCkgPT5cbiAgICBjb3VudC52YWx1ZSA9PT0gMCA/IFwiemVyb1wiIDogY291bnQudmFsdWUgPCA1ID8gXCJmZXdcIiA6IFwibWFueVwiXG4gICk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgNzogdXNlQ29tcHV0ZWQ8L2gzPlxuICAgICAgPHA+XG4gICAgICAgIENvdW50OiA8c3Ryb25nPntjb3VudC52YWx1ZX08L3N0cm9uZz4gfCBMYWJlbDogPHN0cm9uZz57bGFiZWwudmFsdWV9PC9zdHJvbmc+XG4gICAgICA8L3A+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgY291bnQudmFsdWUrKzsgfX0+KzE8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBjb3VudC52YWx1ZSA9IDA7IH19PlJlc2V0PC9idXR0b24+XG4gICAgPC9kaXY+XG4gICk7XG59XG5cbi8vIOKUgOKUgOKUgCBUZXN0IDg6IGJhdGNoKCkgbXVsdGlwbGUgc2lnbmFsIHdyaXRlcyDilIDilIDilIBcbmNvbnN0IGJhdGNoQSA9IHNpZ25hbCgwKTtcbmNvbnN0IGJhdGNoQiA9IHNpZ25hbCgwKTtcblxuZnVuY3Rpb24gVGVzdDhfQmF0Y2goKSB7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgODogYmF0Y2goKTwvaDM+XG4gICAgICA8cD5cbiAgICAgICAgQTogPHN0cm9uZz57YmF0Y2hBLnZhbHVlfTwvc3Ryb25nPiB8IEI6IDxzdHJvbmc+e2JhdGNoQi52YWx1ZX08L3N0cm9uZz5cbiAgICAgIDwvcD5cbiAgICAgIDxidXR0b25cbiAgICAgICAgb25DbGljaz17KCkgPT4ge1xuICAgICAgICAgIGJhdGNoKCgpID0+IHtcbiAgICAgICAgICAgIGJhdGNoQS52YWx1ZSsrO1xuICAgICAgICAgICAgYmF0Y2hCLnZhbHVlICs9IDEwO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9fVxuICAgICAgPlxuICAgICAgICBCYXRjaCB1cGRhdGUgKEErMSwgQisxMClcbiAgICAgIDwvYnV0dG9uPlxuICAgICAgPHAgY2xhc3M9XCJoaW50XCI+U2hvdWxkIHVwZGF0ZSBib3RoIGluIGEgc2luZ2xlIHJlbmRlci48L3A+XG4gICAgPC9kaXY+XG4gICk7XG59XG5cbi8vIOKUgOKUgOKUgCBUZXN0IDk6IERpYWdub3N0aWMg4oCUIGNoZWNrIG9wdGlvbnMgaG9va3MgYXJlIGluc3RhbGxlZCDilIDilIDilIBcbmZ1bmN0aW9uIFRlc3Q5X0RpYWdub3N0aWMoKSB7XG4gIGxldCBpbmZvOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIHRyeSB7XG4gICAgLy8gQHRzLWlnbm9yZSDigJQgYWNjZXNzaW5nIHByZWFjdCBpbnRlcm5hbHNcbiAgICBjb25zdCBvcHRzID0gKGdsb2JhbFRoaXMgYXMgYW55KS5fX1BSRUFDVF9TSUdOQUxTX0hPT0tTX187XG4gICAgaW5mby5nbG9iYWxIb29rID0gb3B0cyA/IFwiZm91bmRcIiA6IFwibm90IGZvdW5kXCI7XG4gIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuXG4gIC8vIENoZWNrIGlmIHByZWFjdCBvcHRpb25zIGhhdmUgYmVlbiBwYXRjaGVkXG4gIHRyeSB7XG4gICAgY29uc3QgcHJlYWN0ID0gcmVxdWlyZShcInByZWFjdFwiKTtcbiAgICBjb25zdCBvcHRLZXlzID0gT2JqZWN0LmtleXMocHJlYWN0Lm9wdGlvbnMgfHwge30pO1xuICAgIGluZm8ucHJlYWN0T3B0aW9ucyA9IG9wdEtleXMuam9pbihcIiwgXCIpIHx8IFwiKGVtcHR5KVwiO1xuICB9IGNhdGNoIHtcbiAgICBpbmZvLnByZWFjdE9wdGlvbnMgPSBcIihjYW5ub3QgYWNjZXNzKVwiO1xuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCA5OiBEaWFnbm9zdGljczwvaDM+XG4gICAgICA8cHJlPntKU09OLnN0cmluZ2lmeShpbmZvLCBudWxsLCAyKX08L3ByZT5cbiAgICAgIDxwPlxuICAgICAgICBTaWRlLWVmZmVjdCBpbXBvcnQgcHJlc2VudDp7XCIgXCJ9XG4gICAgICAgIDxzdHJvbmc+e3R5cGVvZiBzaWduYWwgPT09IFwiZnVuY3Rpb25cIiA/IFwiWUVTXCIgOiBcIk5PXCJ9PC9zdHJvbmc+XG4gICAgICA8L3A+XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5cbiAgICAgICAgSWYgcHJlYWN0T3B0aW9ucyBzaG93cyBfX2IsIF9fciwgZGlmZmVkLCB1bm1vdW50IOKAlCBob29rcyBhcmUgaW5zdGFsbGVkLlxuICAgICAgPC9wPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG4vLyDilIDilIDilIAgVGVzdCAxMDogU2hvdyBjb21wb25lbnQgKGNvbmRpdGlvbmFsIHJlbmRlciB3aXRob3V0IHJlLXJlbmRlcikg4pSA4pSA4pSAXG5jb25zdCBzaG93U2lnbmFsID0gc2lnbmFsPHN0cmluZyB8IG51bGw+KG51bGwpO1xuXG5mdW5jdGlvbiBUZXN0MTBfU2hvdygpIHtcbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCAxMDoge1wiPFNob3c+XCJ9IGNvbXBvbmVudDwvaDM+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgc2hvd1NpZ25hbC52YWx1ZSA9IFwiSGVsbG8gZnJvbSBTaG93IVwiOyB9fT5cbiAgICAgICAgU2hvdyBjb250ZW50XG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBzaG93U2lnbmFsLnZhbHVlID0gbnVsbDsgfX0+SGlkZTwvYnV0dG9uPlxuICAgICAgPFNob3cgd2hlbj17c2hvd1NpZ25hbH0+XG4gICAgICAgIHsodmFsKSA9PiAoXG4gICAgICAgICAgPGRpdiBjbGFzcz1cIm1vY2stbW9kYWxcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJtb2NrLW1vZGFsLWNvbnRlbnRcIj5cbiAgICAgICAgICAgICAgPHN0cm9uZz57dmFsfTwvc3Ryb25nPlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICl9XG4gICAgICA8L1Nob3c+XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5cbiAgICAgICAge1wiPFNob3cgd2hlbj17c2lnbmFsfT5cIn0gcmVuZGVycyBjaGlsZHJlbiBvbmx5IHdoZW4gc2lnbmFsIGlzIHRydXRoeS5cbiAgICAgICAgTm8gcGFyZW50IHJlLXJlbmRlciBuZWVkZWQuXG4gICAgICA8L3A+XG4gICAgPC9kaXY+XG4gICk7XG59XG5cbi8vIOKUgOKUgOKUgCBUZXN0IDEwYjogU2hvdyBmb3IgbW9kYWwgcGF0dGVybiDilIDilIDilIBcbmNvbnN0IHNob3dNb2RhbEV2ZW50ID0gc2lnbmFsPHsgaWQ6IG51bWJlcjsgbmFtZTogc3RyaW5nIH0gfCBudWxsPihudWxsKTtcblxuZnVuY3Rpb24gVGVzdDEwYl9TaG93TW9kYWwoKSB7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgMTBiOiB7XCI8U2hvdz5cIn0gbW9kYWwgcGF0dGVybjwvaDM+XG4gICAgICA8ZGl2IGNsYXNzPVwiaXRlbS1saXN0XCI+XG4gICAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBzaG93TW9kYWxFdmVudC52YWx1ZSA9IHsgaWQ6IDEsIG5hbWU6IFwiQ2hhdG9yYVwiIH07IH19PlxuICAgICAgICAgIENoYXRvcmFcbiAgICAgICAgPC9idXR0b24+XG4gICAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBzaG93TW9kYWxFdmVudC52YWx1ZSA9IHsgaWQ6IDIsIG5hbWU6IFwiTWlrZVwiIH07IH19PlxuICAgICAgICAgIE1pa2VcbiAgICAgICAgPC9idXR0b24+XG4gICAgICA8L2Rpdj5cbiAgICAgIDxTaG93IHdoZW49e3Nob3dNb2RhbEV2ZW50fT5cbiAgICAgICAgeyhldikgPT4gKFxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJtb2NrLW1vZGFsXCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbC1jb250ZW50XCI+XG4gICAgICAgICAgICAgIDxzdHJvbmc+e2V2Lm5hbWV9PC9zdHJvbmc+IChpZD17ZXYuaWR9KVxuICAgICAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgc2hvd01vZGFsRXZlbnQudmFsdWUgPSBudWxsOyB9fT7DlzwvYnV0dG9uPlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICl9XG4gICAgICA8L1Nob3c+XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5cbiAgICAgICAgVGhpcyBpcyB0aGUgaWRlYWwgbW9kYWwgcGF0dGVybiDigJQgbm8gdXNlU3RhdGUsIG5vIGJyaWRnZSwgbm8gcGFyZW50IHJlLXJlbmRlci5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgMTE6IEZvciBjb21wb25lbnQgKGxpc3QgcmVuZGVyKSDilIDilIDilIBcbmNvbnN0IGxpc3RJdGVtcyA9IHNpZ25hbChbXG4gIHsgaWQ6IDEsIG5hbWU6IFwiQ2hhdG9yYVwiIH0sXG4gIHsgaWQ6IDIsIG5hbWU6IFwiTWlrZVwiIH0sXG4gIHsgaWQ6IDMsIG5hbWU6IFwiS2lqaXRvcmFcIiB9LFxuXSk7XG5cbmZ1bmN0aW9uIFRlc3QxMV9Gb3IoKSB7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgMTE6IHtcIjxGb3I+XCJ9IGNvbXBvbmVudDwvaDM+XG4gICAgICA8Rm9yIGVhY2g9e2xpc3RJdGVtc30+XG4gICAgICAgIHsoaXRlbSkgPT4gKFxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJwYWRkaW5nOiA0cHggMDtcIj5cbiAgICAgICAgICAgICN7aXRlbS5pZH0g4oCUIDxzdHJvbmc+e2l0ZW0ubmFtZX08L3N0cm9uZz5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgKX1cbiAgICAgIDwvRm9yPlxuICAgICAgPGJ1dHRvblxuICAgICAgICBvbkNsaWNrPXsoKSA9PiB7XG4gICAgICAgICAgbGlzdEl0ZW1zLnZhbHVlID0gW1xuICAgICAgICAgICAgLi4ubGlzdEl0ZW1zLnZhbHVlLFxuICAgICAgICAgICAgeyBpZDogbGlzdEl0ZW1zLnZhbHVlLmxlbmd0aCArIDEsIG5hbWU6IGBQZXQgIyR7bGlzdEl0ZW1zLnZhbHVlLmxlbmd0aCArIDF9YCB9LFxuICAgICAgICAgIF07XG4gICAgICAgIH19XG4gICAgICA+XG4gICAgICAgIEFkZCBpdGVtXG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxidXR0b25cbiAgICAgICAgb25DbGljaz17KCkgPT4ge1xuICAgICAgICAgIGxpc3RJdGVtcy52YWx1ZSA9IGxpc3RJdGVtcy52YWx1ZS5zbGljZSgwLCAtMSk7XG4gICAgICAgIH19XG4gICAgICA+XG4gICAgICAgIFJlbW92ZSBsYXN0XG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICB7XCI8Rm9yIGVhY2g9e3NpZ25hbH0+XCJ9IGVmZmljaWVudGx5IHJlbmRlcnMgbGlzdHMuIEl0ZW1zIHNob3VsZCBhZGQvcmVtb3ZlIHdpdGhvdXQgZnVsbCByZS1yZW5kZXIuXG4gICAgICA8L3A+XG4gICAgPC9kaXY+XG4gICk7XG59XG5cbi8vIOKUgOKUgOKUgCBUZXN0IDEyOiBTaG93ICsgdXNlTW9kZWwgKHByb2R1Y3Rpb24tcmVhZHkgcGF0dGVybikg4pSA4pSA4pSAXG5jb25zdCBGdWxsU3RvcmUgPSBjcmVhdGVNb2RlbCgoKSA9PiB7XG4gIGNvbnN0IHNlbGVjdGVkID0gc2lnbmFsPHsgaWQ6IG51bWJlcjsgbmFtZTogc3RyaW5nIH0gfCBudWxsPihudWxsKTtcbiAgY29uc3QgaXRlbXMgPSBzaWduYWwoW1xuICAgIHsgaWQ6IDEsIG5hbWU6IFwiQ2hhdG9yYSBzbGVlcGluZ1wiIH0sXG4gICAgeyBpZDogMiwgbmFtZTogXCJNaWtlIGVhdGluZ1wiIH0sXG4gICAgeyBpZDogMywgbmFtZTogXCJLaWppdG9yYSBwbGF5aW5nXCIgfSxcbiAgXSk7XG4gIGNvbnN0IG9wZW5Nb2RhbCA9IGFjdGlvbigoaXRlbTogeyBpZDogbnVtYmVyOyBuYW1lOiBzdHJpbmcgfSkgPT4ge1xuICAgIHNlbGVjdGVkLnZhbHVlID0gaXRlbTtcbiAgfSk7XG4gIGNvbnN0IGNsb3NlTW9kYWwgPSBhY3Rpb24oKCkgPT4ge1xuICAgIHNlbGVjdGVkLnZhbHVlID0gbnVsbDtcbiAgfSk7XG4gIHJldHVybiB7IHNlbGVjdGVkLCBpdGVtcywgb3Blbk1vZGFsLCBjbG9zZU1vZGFsIH07XG59KTtcblxuZnVuY3Rpb24gVGVzdDEyX0Z1bGxQYXR0ZXJuKCkge1xuICBjb25zdCBzdG9yZSA9IHVzZU1vZGVsKEZ1bGxTdG9yZSk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgMTI6IHVzZU1vZGVsICsgU2hvdyArIEZvciAodGFyZ2V0IHBhdHRlcm4pPC9oMz5cbiAgICAgIDxGb3IgZWFjaD17c3RvcmUuaXRlbXN9PlxuICAgICAgICB7KGl0ZW0pID0+IChcbiAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHN0b3JlLm9wZW5Nb2RhbChpdGVtKX0+XG4gICAgICAgICAgICB7aXRlbS5uYW1lfVxuICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICApfVxuICAgICAgPC9Gb3I+XG4gICAgICA8U2hvdyB3aGVuPXtzdG9yZS5zZWxlY3RlZH0+XG4gICAgICAgIHsoZXYpID0+IChcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbFwiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cIm1vY2stbW9kYWwtY29udGVudFwiPlxuICAgICAgICAgICAgICA8c3Ryb25nPntldi5uYW1lfTwvc3Ryb25nPlxuICAgICAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9e3N0b3JlLmNsb3NlTW9kYWx9PsOXPC9idXR0b24+XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgKX1cbiAgICAgIDwvU2hvdz5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBUaGUgaWRlYWwgcHJvZHVjdGlvbiBwYXR0ZXJuOiBjcmVhdGVNb2RlbCArIHVzZU1vZGVsICsgU2hvdyArIEZvci5cbiAgICAgICAgTm8gdXNlU3RhdGUsIG5vIHVzZVNpZ25hbEVmZmVjdCBicmlkZ2UsIG5vIHBhcmVudCByZS1yZW5kZXJzLlxuICAgICAgPC9wPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG4vLyDilIDilIDilIAgQXBwIOKUgOKUgOKUgFxuZnVuY3Rpb24gU2lnbmFsc1Rlc3RBcHAoKSB7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtYXBwXCI+XG4gICAgICA8aDE+QHByZWFjdC9zaWduYWxzIFRlc3QgQmVuY2g8L2gxPlxuICAgICAgPHAgY2xhc3M9XCJzdWJ0aXRsZVwiPlxuICAgICAgICBWZXJpZnkgc2lnbmFsIHJlYWN0aXZpdHkgcGF0dGVybnMgYmVmb3JlIHByb2R1Y3Rpb24gdXNlLlxuICAgICAgICA8YnIgLz5cbiAgICAgICAgQnVpbGQ6IEJ1biB7dHlwZW9mIEJ1biAhPT0gXCJ1bmRlZmluZWRcIiA/IFwicnVudGltZVwiIDogXCJidW5kbGVkXCJ9IHxcbiAgICAgICAgQHByZWFjdC9zaWduYWxzIDIuOC4yXG4gICAgICA8L3A+XG4gICAgICA8ZGl2IGNsYXNzPVwidGVzdC1ncmlkXCI+XG4gICAgICAgIDxUZXN0MV9BdXRvU3Vic2NyaWJlIC8+XG4gICAgICAgIDxUZXN0Ml9CcmlkZ2UgLz5cbiAgICAgICAgPFRlc3QzX01vZGVsIC8+XG4gICAgICAgIDxUZXN0Nl9Vc2VTaWduYWwgLz5cbiAgICAgICAgPFRlc3Q3X1VzZUNvbXB1dGVkIC8+XG4gICAgICAgIDxUZXN0OF9CYXRjaCAvPlxuICAgICAgPC9kaXY+XG4gICAgICA8aDI+TW9kYWwgVGVzdHMgKHRoZSBicm9rZW4gY2FzZSk8L2gyPlxuICAgICAgPGRpdiBjbGFzcz1cInRlc3QtZ3JpZFwiPlxuICAgICAgICA8VGVzdDRfTW9kYWwgLz5cbiAgICAgICAgPFRlc3Q0Yl9Nb2RhbEJyaWRnZSAvPlxuICAgICAgICA8VGVzdDVfU3RvcmVNb2RhbCAvPlxuICAgICAgICA8VGVzdDViX1N0b3JlTW9kYWxCcmlkZ2UgLz5cbiAgICAgIDwvZGl2PlxuICAgICAgPGgyPlNob3cgLyBGb3IgKGRlY2xhcmF0aXZlIHBhdHRlcm4pPC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJ0ZXN0LWdyaWRcIj5cbiAgICAgICAgPFRlc3QxMF9TaG93IC8+XG4gICAgICAgIDxUZXN0MTBiX1Nob3dNb2RhbCAvPlxuICAgICAgICA8VGVzdDExX0ZvciAvPlxuICAgICAgICA8VGVzdDEyX0Z1bGxQYXR0ZXJuIC8+XG4gICAgICA8L2Rpdj5cbiAgICAgIDxoMj5EaWFnbm9zdGljczwvaDI+XG4gICAgICA8VGVzdDlfRGlhZ25vc3RpYyAvPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG5jb25zdCByb290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhcHBcIik7XG5pZiAoIXJvb3QpIHRocm93IG5ldyBFcnJvcihcIiNhcHAgcm9vdCBub3QgZm91bmRcIik7XG5yZW5kZXIoPFNpZ25hbHNUZXN0QXBwIC8+LCByb290KTtcbiIsCiAgICAiaW1wb3J0e29wdGlvbnMgYXMgbn1mcm9tXCJwcmVhY3RcIjt2YXIgdCxyLHUsaSxvPTAsZj1bXSxjPW4sZT1jLl9fYixhPWMuX19yLHY9Yy5kaWZmZWQsbD1jLl9fYyxtPWMudW5tb3VudCxzPWMuX187ZnVuY3Rpb24gcChuLHQpe2MuX19oJiZjLl9faChyLG4sb3x8dCksbz0wO3ZhciB1PXIuX19IfHwoci5fX0g9e19fOltdLF9faDpbXX0pO3JldHVybiBuPj11Ll9fLmxlbmd0aCYmdS5fXy5wdXNoKHt9KSx1Ll9fW25dfWZ1bmN0aW9uIGQobil7cmV0dXJuIG89MSxoKEQsbil9ZnVuY3Rpb24gaChuLHUsaSl7dmFyIG89cCh0KyssMik7aWYoby50PW4sIW8uX19jJiYoby5fXz1baT9pKHUpOkQodm9pZCAwLHUpLGZ1bmN0aW9uKG4pe3ZhciB0PW8uX19OP28uX19OWzBdOm8uX19bMF0scj1vLnQodCxuKTt0IT09ciYmKG8uX19OPVtyLG8uX19bMV1dLG8uX19jLnNldFN0YXRlKHt9KSl9XSxvLl9fYz1yLCFyLl9fZikpe3ZhciBmPWZ1bmN0aW9uKG4sdCxyKXtpZighby5fX2MuX19IKXJldHVybiEwO3ZhciB1PW8uX19jLl9fSC5fXy5maWx0ZXIoZnVuY3Rpb24obil7cmV0dXJuIG4uX19jfSk7aWYodS5ldmVyeShmdW5jdGlvbihuKXtyZXR1cm4hbi5fX059KSlyZXR1cm4hY3x8Yy5jYWxsKHRoaXMsbix0LHIpO3ZhciBpPW8uX19jLnByb3BzIT09bjtyZXR1cm4gdS5zb21lKGZ1bmN0aW9uKG4pe2lmKG4uX19OKXt2YXIgdD1uLl9fWzBdO24uX189bi5fX04sbi5fX049dm9pZCAwLHQhPT1uLl9fWzBdJiYoaT0hMCl9fSksYyYmYy5jYWxsKHRoaXMsbix0LHIpfHxpfTtyLl9fZj0hMDt2YXIgYz1yLnNob3VsZENvbXBvbmVudFVwZGF0ZSxlPXIuY29tcG9uZW50V2lsbFVwZGF0ZTtyLmNvbXBvbmVudFdpbGxVcGRhdGU9ZnVuY3Rpb24obix0LHIpe2lmKHRoaXMuX19lKXt2YXIgdT1jO2M9dm9pZCAwLGYobix0LHIpLGM9dX1lJiZlLmNhbGwodGhpcyxuLHQscil9LHIuc2hvdWxkQ29tcG9uZW50VXBkYXRlPWZ9cmV0dXJuIG8uX19OfHxvLl9ffWZ1bmN0aW9uIHkobix1KXt2YXIgaT1wKHQrKywzKTshYy5fX3MmJkMoaS5fX0gsdSkmJihpLl9fPW4saS51PXUsci5fX0guX19oLnB1c2goaSkpfWZ1bmN0aW9uIF8obix1KXt2YXIgaT1wKHQrKyw0KTshYy5fX3MmJkMoaS5fX0gsdSkmJihpLl9fPW4saS51PXUsci5fX2gucHVzaChpKSl9ZnVuY3Rpb24gQShuKXtyZXR1cm4gbz01LFQoZnVuY3Rpb24oKXtyZXR1cm57Y3VycmVudDpufX0sW10pfWZ1bmN0aW9uIEYobix0LHIpe289NixfKGZ1bmN0aW9uKCl7aWYoXCJmdW5jdGlvblwiPT10eXBlb2Ygbil7dmFyIHI9bih0KCkpO3JldHVybiBmdW5jdGlvbigpe24obnVsbCksciYmXCJmdW5jdGlvblwiPT10eXBlb2YgciYmcigpfX1pZihuKXJldHVybiBuLmN1cnJlbnQ9dCgpLGZ1bmN0aW9uKCl7cmV0dXJuIG4uY3VycmVudD1udWxsfX0sbnVsbD09cj9yOnIuY29uY2F0KG4pKX1mdW5jdGlvbiBUKG4scil7dmFyIHU9cCh0KyssNyk7cmV0dXJuIEModS5fX0gscikmJih1Ll9fPW4oKSx1Ll9fSD1yLHUuX19oPW4pLHUuX199ZnVuY3Rpb24gcShuLHQpe3JldHVybiBvPTgsVChmdW5jdGlvbigpe3JldHVybiBufSx0KX1mdW5jdGlvbiB4KG4pe3ZhciB1PXIuY29udGV4dFtuLl9fY10saT1wKHQrKyw5KTtyZXR1cm4gaS5jPW4sdT8obnVsbD09aS5fXyYmKGkuX189ITAsdS5zdWIocikpLHUucHJvcHMudmFsdWUpOm4uX199ZnVuY3Rpb24gUChuLHQpe2MudXNlRGVidWdWYWx1ZSYmYy51c2VEZWJ1Z1ZhbHVlKHQ/dChuKTpuKX1mdW5jdGlvbiBiKG4pe3ZhciB1PXAodCsrLDEwKSxpPWQoKTtyZXR1cm4gdS5fXz1uLHIuY29tcG9uZW50RGlkQ2F0Y2h8fChyLmNvbXBvbmVudERpZENhdGNoPWZ1bmN0aW9uKG4sdCl7dS5fXyYmdS5fXyhuLHQpLGlbMV0obil9KSxbaVswXSxmdW5jdGlvbigpe2lbMV0odm9pZCAwKX1dfWZ1bmN0aW9uIGcoKXt2YXIgbj1wKHQrKywxMSk7aWYoIW4uX18pe2Zvcih2YXIgdT1yLl9fdjtudWxsIT09dSYmIXUuX19tJiZudWxsIT09dS5fXzspdT11Ll9fO3ZhciBpPXUuX19tfHwodS5fX209WzAsMF0pO24uX189XCJQXCIraVswXStcIi1cIitpWzFdKyt9cmV0dXJuIG4uX199ZnVuY3Rpb24gaigpe2Zvcih2YXIgbjtuPWYuc2hpZnQoKTspe3ZhciB0PW4uX19IO2lmKG4uX19QJiZ0KXRyeXt0Ll9faC5zb21lKHopLHQuX19oLnNvbWUoQiksdC5fX2g9W119Y2F0Y2gocil7dC5fX2g9W10sYy5fX2UocixuLl9fdil9fX1jLl9fYj1mdW5jdGlvbihuKXtyPW51bGwsZSYmZShuKX0sYy5fXz1mdW5jdGlvbihuLHQpe24mJnQuX19rJiZ0Ll9fay5fX20mJihuLl9fbT10Ll9fay5fX20pLHMmJnMobix0KX0sYy5fX3I9ZnVuY3Rpb24obil7YSYmYShuKSx0PTA7dmFyIGk9KHI9bi5fX2MpLl9fSDtpJiYodT09PXI/KGkuX19oPVtdLHIuX19oPVtdLGkuX18uc29tZShmdW5jdGlvbihuKXtuLl9fTiYmKG4uX189bi5fX04pLG4udT1uLl9fTj12b2lkIDB9KSk6KGkuX19oLnNvbWUoeiksaS5fX2guc29tZShCKSxpLl9faD1bXSx0PTApKSx1PXJ9LGMuZGlmZmVkPWZ1bmN0aW9uKG4pe3YmJnYobik7dmFyIHQ9bi5fX2M7dCYmdC5fX0gmJih0Ll9fSC5fX2gubGVuZ3RoJiYoMSE9PWYucHVzaCh0KSYmaT09PWMucmVxdWVzdEFuaW1hdGlvbkZyYW1lfHwoKGk9Yy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUpfHx3KShqKSksdC5fX0guX18uc29tZShmdW5jdGlvbihuKXtuLnUmJihuLl9fSD1uLnUpLG4udT12b2lkIDB9KSksdT1yPW51bGx9LGMuX19jPWZ1bmN0aW9uKG4sdCl7dC5zb21lKGZ1bmN0aW9uKG4pe3RyeXtuLl9faC5zb21lKHopLG4uX19oPW4uX19oLmZpbHRlcihmdW5jdGlvbihuKXtyZXR1cm4hbi5fX3x8QihuKX0pfWNhdGNoKHIpe3Quc29tZShmdW5jdGlvbihuKXtuLl9faCYmKG4uX19oPVtdKX0pLHQ9W10sYy5fX2UocixuLl9fdil9fSksbCYmbChuLHQpfSxjLnVubW91bnQ9ZnVuY3Rpb24obil7bSYmbShuKTt2YXIgdCxyPW4uX19jO3ImJnIuX19IJiYoci5fX0guX18uc29tZShmdW5jdGlvbihuKXt0cnl7eihuKX1jYXRjaChuKXt0PW59fSksci5fX0g9dm9pZCAwLHQmJmMuX19lKHQsci5fX3YpKX07dmFyIGs9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWVzdEFuaW1hdGlvbkZyYW1lO2Z1bmN0aW9uIHcobil7dmFyIHQscj1mdW5jdGlvbigpe2NsZWFyVGltZW91dCh1KSxrJiZjYW5jZWxBbmltYXRpb25GcmFtZSh0KSxzZXRUaW1lb3V0KG4pfSx1PXNldFRpbWVvdXQociwzNSk7ayYmKHQ9cmVxdWVzdEFuaW1hdGlvbkZyYW1lKHIpKX1mdW5jdGlvbiB6KG4pe3ZhciB0PXIsdT1uLl9fYztcImZ1bmN0aW9uXCI9PXR5cGVvZiB1JiYobi5fX2M9dm9pZCAwLHUoKSkscj10fWZ1bmN0aW9uIEIobil7dmFyIHQ9cjtuLl9fYz1uLl9fKCkscj10fWZ1bmN0aW9uIEMobix0KXtyZXR1cm4hbnx8bi5sZW5ndGghPT10Lmxlbmd0aHx8dC5zb21lKGZ1bmN0aW9uKHQscil7cmV0dXJuIHQhPT1uW3JdfSl9ZnVuY3Rpb24gRChuLHQpe3JldHVyblwiZnVuY3Rpb25cIj09dHlwZW9mIHQ/dChuKTp0fWV4cG9ydHtxIGFzIHVzZUNhbGxiYWNrLHggYXMgdXNlQ29udGV4dCxQIGFzIHVzZURlYnVnVmFsdWUseSBhcyB1c2VFZmZlY3QsYiBhcyB1c2VFcnJvckJvdW5kYXJ5LGcgYXMgdXNlSWQsRiBhcyB1c2VJbXBlcmF0aXZlSGFuZGxlLF8gYXMgdXNlTGF5b3V0RWZmZWN0LFQgYXMgdXNlTWVtbyxoIGFzIHVzZVJlZHVjZXIsQSBhcyB1c2VSZWYsZCBhcyB1c2VTdGF0ZX07XG4vLyMgc291cmNlTWFwcGluZ1VSTD1ob29rcy5tb2R1bGUuanMubWFwXG4iLAogICAgImltcG9ydHtDb21wb25lbnQgYXMgaSxvcHRpb25zIGFzIG4saXNWYWxpZEVsZW1lbnQgYXMgcixGcmFnbWVudCBhcyB0fWZyb21cInByZWFjdFwiO2ltcG9ydHt1c2VNZW1vIGFzIG8sdXNlUmVmIGFzIGUsdXNlRWZmZWN0IGFzIGZ9ZnJvbVwicHJlYWN0L2hvb2tzXCI7aW1wb3J0e2VmZmVjdCBhcyB1LFNpZ25hbCBhcyBhLGNvbXB1dGVkIGFzIGMsc2lnbmFsIGFzIHYsYmF0Y2ggYXMgc31mcm9tXCJAcHJlYWN0L3NpZ25hbHMtY29yZVwiO2V4cG9ydHtTaWduYWwsYWN0aW9uLGJhdGNoLGNvbXB1dGVkLGNyZWF0ZU1vZGVsLGVmZmVjdCxzaWduYWwsdW50cmFja2VkfWZyb21cIkBwcmVhY3Qvc2lnbmFscy1jb3JlXCI7dmFyIGwsZCxoLHA9XCJ1bmRlZmluZWRcIiE9dHlwZW9mIHdpbmRvdyYmISF3aW5kb3cuX19QUkVBQ1RfU0lHTkFMU19ERVZUT09MU19fLG09W10sXz1bXTt1KGZ1bmN0aW9uKCl7bD10aGlzLk59KSgpO2Z1bmN0aW9uIGcoaSxyKXtuW2ldPXIuYmluZChudWxsLG5baV18fGZ1bmN0aW9uKCl7fSl9ZnVuY3Rpb24gYihpKXtpZihoKXt2YXIgbj1oO2g9dm9pZCAwO24oKX1oPWkmJmkuUygpfWZ1bmN0aW9uIHkoaSl7dmFyIG49dGhpcyx0PWkuZGF0YSxlPXVzZVNpZ25hbCh0KTtlLnZhbHVlPXQ7dmFyIGY9byhmdW5jdGlvbigpe3ZhciBpPW4sdD1uLl9fdjt3aGlsZSh0PXQuX18paWYodC5fX2Mpe3QuX19jLl9fJGZ8PTQ7YnJlYWt9dmFyIG89YyhmdW5jdGlvbigpe3ZhciBpPWUudmFsdWUudmFsdWU7cmV0dXJuIDA9PT1pPzA6ITA9PT1pP1wiXCI6aXx8XCJcIn0pLGY9YyhmdW5jdGlvbigpe3JldHVybiFBcnJheS5pc0FycmF5KG8udmFsdWUpJiYhcihvLnZhbHVlKX0pLGE9dShmdW5jdGlvbigpe3RoaXMuTj1GO2lmKGYudmFsdWUpe3ZhciBuPW8udmFsdWU7aWYoaS5fX3YmJmkuX192Ll9fZSYmMz09PWkuX192Ll9fZS5ub2RlVHlwZSlpLl9fdi5fX2UuZGF0YT1ufX0pLHY9bi5fXyR1LmQ7bi5fXyR1LmQ9ZnVuY3Rpb24oKXthKCk7di5jYWxsKHRoaXMpfTtyZXR1cm5bZixvXX0sW10pLGE9ZlswXSx2PWZbMV07cmV0dXJuIGEudmFsdWU/di5wZWVrKCk6di52YWx1ZX15LmRpc3BsYXlOYW1lPVwiUmVhY3RpdmVUZXh0Tm9kZVwiO09iamVjdC5kZWZpbmVQcm9wZXJ0aWVzKGEucHJvdG90eXBlLHtjb25zdHJ1Y3Rvcjp7Y29uZmlndXJhYmxlOiEwLHZhbHVlOnZvaWQgMH0sdHlwZTp7Y29uZmlndXJhYmxlOiEwLHZhbHVlOnl9LHByb3BzOntjb25maWd1cmFibGU6ITAsZ2V0OmZ1bmN0aW9uKCl7dmFyIGk9dGhpcztyZXR1cm57ZGF0YTp7Z2V0IHZhbHVlKCl7cmV0dXJuIGkudmFsdWV9fX19fSxfX2I6e2NvbmZpZ3VyYWJsZTohMCx2YWx1ZToxfX0pO2coXCJfX2JcIixmdW5jdGlvbihpLG4pe2lmKFwic3RyaW5nXCI9PXR5cGVvZiBuLnR5cGUpe3ZhciByLHQ9bi5wcm9wcztmb3IodmFyIG8gaW4gdClpZihcImNoaWxkcmVuXCIhPT1vKXt2YXIgZT10W29dO2lmKGUgaW5zdGFuY2VvZiBhKXtpZighciluLl9fbnA9cj17fTtyW29dPWU7dFtvXT1lLnBlZWsoKX19fWkobil9KTtnKFwiX19yXCIsZnVuY3Rpb24oaSxuKXtpKG4pO2lmKG4udHlwZSE9PXQpe2IoKTt2YXIgcixvPW4uX19jO2lmKG8pe28uX18kZiY9LTI7aWYodm9pZCAwPT09KHI9by5fXyR1KSlvLl9fJHU9cj1mdW5jdGlvbihpLG4pe3ZhciByO3UoZnVuY3Rpb24oKXtyPXRoaXN9LHtuYW1lOm59KTtyLmM9aTtyZXR1cm4gcn0oZnVuY3Rpb24oKXt2YXIgaTtpZihwKW51bGw9PShpPXIueSl8fGkuY2FsbChyKTtvLl9fJGZ8PTE7by5zZXRTdGF0ZSh7fSl9LFwiZnVuY3Rpb25cIj09dHlwZW9mIG4udHlwZT9uLnR5cGUuZGlzcGxheU5hbWV8fG4udHlwZS5uYW1lOlwiXCIpfWQ9bztiKHIpfX0pO2coXCJfX2VcIixmdW5jdGlvbihpLG4scix0KXtiKCk7ZD12b2lkIDA7aShuLHIsdCl9KTtnKFwiZGlmZmVkXCIsZnVuY3Rpb24oaSxuKXtiKCk7ZD12b2lkIDA7dmFyIHI7aWYoXCJzdHJpbmdcIj09dHlwZW9mIG4udHlwZSYmKHI9bi5fX2UpKXt2YXIgdD1uLl9fbnAsbz1uLnByb3BzO2lmKHQpe3ZhciBlPXIuVTtpZihlKWZvcih2YXIgZiBpbiBlKXt2YXIgdT1lW2ZdO2lmKHZvaWQgMCE9PXUmJiEoZiBpbiB0KSl7dS5kKCk7ZVtmXT12b2lkIDB9fWVsc2V7ZT17fTtyLlU9ZX1mb3IodmFyIGEgaW4gdCl7dmFyIGM9ZVthXSx2PXRbYV07aWYodm9pZCAwPT09Yyl7Yz13KHIsYSx2KTtlW2FdPWN9ZWxzZSBjLm8odixvKX1mb3IodmFyIHMgaW4gdClvW3NdPXRbc119fWkobil9KTtmdW5jdGlvbiB3KGksbixyLHQpe3ZhciBvPW4gaW4gaSYmdm9pZCAwPT09aS5vd25lclNWR0VsZW1lbnQsZT12KHIpLGY9ci5wZWVrKCk7cmV0dXJue286ZnVuY3Rpb24oaSxuKXtlLnZhbHVlPWk7Zj1pLnBlZWsoKX0sZDp1KGZ1bmN0aW9uKCl7dGhpcy5OPUY7dmFyIHI9ZS52YWx1ZS52YWx1ZTtpZihmIT09cil7Zj12b2lkIDA7aWYobylpW25dPXI7ZWxzZSBpZihudWxsIT1yJiYoITEhPT1yfHxcIi1cIj09PW5bNF0pKWkuc2V0QXR0cmlidXRlKG4scik7ZWxzZSBpLnJlbW92ZUF0dHJpYnV0ZShuKX1lbHNlIGY9dm9pZCAwfSl9fWcoXCJ1bm1vdW50XCIsZnVuY3Rpb24oaSxuKXtpZihcInN0cmluZ1wiPT10eXBlb2Ygbi50eXBlKXt2YXIgcj1uLl9fZTtpZihyKXt2YXIgdD1yLlU7aWYodCl7ci5VPXZvaWQgMDtmb3IodmFyIG8gaW4gdCl7dmFyIGU9dFtvXTtpZihlKWUuZCgpfX19bi5fX25wPXZvaWQgMH1lbHNle3ZhciBmPW4uX19jO2lmKGYpe3ZhciB1PWYuX18kdTtpZih1KXtmLl9fJHU9dm9pZCAwO3UuZCgpfX19aShuKX0pO2coXCJfX2hcIixmdW5jdGlvbihpLG4scix0KXtpZih0PDN8fDk9PT10KW4uX18kZnw9MjtpKG4scix0KX0pO2kucHJvdG90eXBlLnNob3VsZENvbXBvbmVudFVwZGF0ZT1mdW5jdGlvbihpLG4pe2lmKHRoaXMuX19SKXJldHVybiEwO3ZhciByPXRoaXMuX18kdSx0PXImJnZvaWQgMCE9PXIucztmb3IodmFyIG8gaW4gbilyZXR1cm4hMDtpZih0aGlzLl9fZnx8XCJib29sZWFuXCI9PXR5cGVvZiB0aGlzLnUmJiEwPT09dGhpcy51KXt2YXIgZT0yJnRoaXMuX18kZjtpZighKHR8fGV8fDQmdGhpcy5fXyRmKSlyZXR1cm4hMDtpZigxJnRoaXMuX18kZilyZXR1cm4hMH1lbHNle2lmKCEodHx8NCZ0aGlzLl9fJGYpKXJldHVybiEwO2lmKDMmdGhpcy5fXyRmKXJldHVybiEwfWZvcih2YXIgZiBpbiBpKWlmKFwiX19zb3VyY2VcIiE9PWYmJmlbZl0hPT10aGlzLnByb3BzW2ZdKXJldHVybiEwO2Zvcih2YXIgdSBpbiB0aGlzLnByb3BzKWlmKCEodSBpbiBpKSlyZXR1cm4hMDtyZXR1cm4hMX07ZnVuY3Rpb24gdXNlU2lnbmFsKGksbil7cmV0dXJuIG8oZnVuY3Rpb24oKXtyZXR1cm4gdihpLG4pfSxbXSl9ZnVuY3Rpb24gdXNlQ29tcHV0ZWQoaSxuKXt2YXIgcj1lKGkpO3IuY3VycmVudD1pO2QuX18kZnw9NDtyZXR1cm4gbyhmdW5jdGlvbigpe3JldHVybiBjKGZ1bmN0aW9uKCl7cmV0dXJuIHIuY3VycmVudCgpfSxuKX0sW10pfXZhciBrPVwidW5kZWZpbmVkXCI9PXR5cGVvZiByZXF1ZXN0QW5pbWF0aW9uRnJhbWU/c2V0VGltZW91dDpmdW5jdGlvbihpKXt2YXIgbj1mdW5jdGlvbigpe2NsZWFyVGltZW91dChyKTtjYW5jZWxBbmltYXRpb25GcmFtZSh0KTtpKCl9LHI9c2V0VGltZW91dChuLDM1KSx0PXJlcXVlc3RBbmltYXRpb25GcmFtZShuKX0scT1mdW5jdGlvbihpKXtxdWV1ZU1pY3JvdGFzayhmdW5jdGlvbigpe3F1ZXVlTWljcm90YXNrKGkpfSl9O2Z1bmN0aW9uIEEoKXtzKGZ1bmN0aW9uKCl7dmFyIGk7d2hpbGUoaT1tLnNoaWZ0KCkpbC5jYWxsKGkpfSl9ZnVuY3Rpb24gVCgpe2lmKDE9PT1tLnB1c2godGhpcykpKG4ucmVxdWVzdEFuaW1hdGlvbkZyYW1lfHxrKShBKX1mdW5jdGlvbiB4KCl7cyhmdW5jdGlvbigpe3ZhciBpO3doaWxlKGk9Xy5zaGlmdCgpKWwuY2FsbChpKX0pfWZ1bmN0aW9uIEYoKXtpZigxPT09Xy5wdXNoKHRoaXMpKShuLnJlcXVlc3RBbmltYXRpb25GcmFtZXx8cSkoeCl9ZnVuY3Rpb24gdXNlU2lnbmFsRWZmZWN0KGksbil7dmFyIHI9ZShpKTtyLmN1cnJlbnQ9aTtmKGZ1bmN0aW9uKCl7cmV0dXJuIHUoZnVuY3Rpb24oKXt0aGlzLk49VDtyZXR1cm4gci5jdXJyZW50KCl9LG4pfSxbXSl9ZnVuY3Rpb24gTShpKXt2YXIgbj1vKGZ1bmN0aW9uKCl7cmV0dXJuIGkoKX0sW10pO2YoZnVuY3Rpb24oKXtyZXR1cm4gbltTeW1ib2wuZGlzcG9zZV19LFtuXSk7cmV0dXJuIG59ZXhwb3J0e3VzZUNvbXB1dGVkLE0gYXMgdXNlTW9kZWwsdXNlU2lnbmFsLHVzZVNpZ25hbEVmZmVjdH07Ly8jIHNvdXJjZU1hcHBpbmdVUkw9c2lnbmFscy5tb2R1bGUuanMubWFwXG4iLAogICAgInZhciBpPVN5bWJvbC5mb3IoXCJwcmVhY3Qtc2lnbmFsc1wiKTtmdW5jdGlvbiB0KCl7aWYoIShzPjEpKXt2YXIgaSx0PSExOyFmdW5jdGlvbigpe3ZhciBpPWQ7ZD12b2lkIDA7d2hpbGUodm9pZCAwIT09aSl7aWYoaS5TLnY9PT1pLnYpaS5TLmk9aS5pO2k9aS5vfX0oKTt3aGlsZSh2b2lkIDAhPT1oKXt2YXIgbj1oO2g9dm9pZCAwO3YrKzt3aGlsZSh2b2lkIDAhPT1uKXt2YXIgcj1uLnU7bi51PXZvaWQgMDtuLmYmPS0zO2lmKCEoOCZuLmYpJiZ3KG4pKXRyeXtuLmMoKX1jYXRjaChuKXtpZighdCl7aT1uO3Q9ITB9fW49cn19dj0wO3MtLTtpZih0KXRocm93IGl9ZWxzZSBzLS19ZnVuY3Rpb24gbihpKXtpZihzPjApcmV0dXJuIGkoKTtlPSsrdTtzKys7dHJ5e3JldHVybiBpKCl9ZmluYWxseXt0KCl9fXZhciByPXZvaWQgMDtmdW5jdGlvbiBvKGkpe3ZhciB0PXI7cj12b2lkIDA7dHJ5e3JldHVybiBpKCl9ZmluYWxseXtyPXR9fXZhciBmLGg9dm9pZCAwLHM9MCx2PTAsdT0wLGU9MCxkPXZvaWQgMCxjPTA7ZnVuY3Rpb24gYShpKXtpZih2b2lkIDAhPT1yKXt2YXIgdD1pLm47aWYodm9pZCAwPT09dHx8dC50IT09cil7dD17aTowLFM6aSxwOnIucyxuOnZvaWQgMCx0OnIsZTp2b2lkIDAseDp2b2lkIDAscjp0fTtpZih2b2lkIDAhPT1yLnMpci5zLm49dDtyLnM9dDtpLm49dDtpZigzMiZyLmYpaS5TKHQpO3JldHVybiB0fWVsc2UgaWYoLTE9PT10Lmkpe3QuaT0wO2lmKHZvaWQgMCE9PXQubil7dC5uLnA9dC5wO2lmKHZvaWQgMCE9PXQucCl0LnAubj10Lm47dC5wPXIuczt0Lm49dm9pZCAwO3Iucy5uPXQ7ci5zPXR9cmV0dXJuIHR9fX1mdW5jdGlvbiBsKGksdCl7dGhpcy52PWk7dGhpcy5pPTA7dGhpcy5uPXZvaWQgMDt0aGlzLnQ9dm9pZCAwO3RoaXMubD0wO3RoaXMuVz1udWxsPT10P3ZvaWQgMDp0LndhdGNoZWQ7dGhpcy5aPW51bGw9PXQ/dm9pZCAwOnQudW53YXRjaGVkO3RoaXMubmFtZT1udWxsPT10P3ZvaWQgMDp0Lm5hbWV9bC5wcm90b3R5cGUuYnJhbmQ9aTtsLnByb3RvdHlwZS5oPWZ1bmN0aW9uKCl7cmV0dXJuITB9O2wucHJvdG90eXBlLlM9ZnVuY3Rpb24oaSl7dmFyIHQ9dGhpcyxuPXRoaXMudDtpZihuIT09aSYmdm9pZCAwPT09aS5lKXtpLng9bjt0aGlzLnQ9aTtpZih2b2lkIDAhPT1uKW4uZT1pO2Vsc2UgbyhmdW5jdGlvbigpe3ZhciBpO251bGw9PShpPXQuVyl8fGkuY2FsbCh0KX0pfX07bC5wcm90b3R5cGUuVT1mdW5jdGlvbihpKXt2YXIgdD10aGlzO2lmKHZvaWQgMCE9PXRoaXMudCl7dmFyIG49aS5lLHI9aS54O2lmKHZvaWQgMCE9PW4pe24ueD1yO2kuZT12b2lkIDB9aWYodm9pZCAwIT09cil7ci5lPW47aS54PXZvaWQgMH1pZihpPT09dGhpcy50KXt0aGlzLnQ9cjtpZih2b2lkIDA9PT1yKW8oZnVuY3Rpb24oKXt2YXIgaTtudWxsPT0oaT10LlopfHxpLmNhbGwodCl9KX19fTtsLnByb3RvdHlwZS5zdWJzY3JpYmU9ZnVuY3Rpb24oaSl7dmFyIHQ9dGhpcztyZXR1cm4gQyhmdW5jdGlvbigpe3ZhciBuPXQudmFsdWUsbz1yO3I9dm9pZCAwO3RyeXtpKG4pfWZpbmFsbHl7cj1vfX0se25hbWU6XCJzdWJcIn0pfTtsLnByb3RvdHlwZS52YWx1ZU9mPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudmFsdWV9O2wucHJvdG90eXBlLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudmFsdWUrXCJcIn07bC5wcm90b3R5cGUudG9KU09OPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudmFsdWV9O2wucHJvdG90eXBlLnBlZWs9ZnVuY3Rpb24oKXt2YXIgaT1yO3I9dm9pZCAwO3RyeXtyZXR1cm4gdGhpcy52YWx1ZX1maW5hbGx5e3I9aX19O09iamVjdC5kZWZpbmVQcm9wZXJ0eShsLnByb3RvdHlwZSxcInZhbHVlXCIse2dldDpmdW5jdGlvbigpe3ZhciBpPWEodGhpcyk7aWYodm9pZCAwIT09aSlpLmk9dGhpcy5pO3JldHVybiB0aGlzLnZ9LHNldDpmdW5jdGlvbihpKXtpZihpIT09dGhpcy52KXtpZih2PjEwMCl0aHJvdyBuZXcgRXJyb3IoXCJDeWNsZSBkZXRlY3RlZFwiKTshZnVuY3Rpb24oaSl7aWYoMCE9PXMmJjA9PT12KWlmKGkubCE9PWUpe2kubD1lO2Q9e1M6aSx2OmkudixpOmkuaSxvOmR9fX0odGhpcyk7dGhpcy52PWk7dGhpcy5pKys7YysrO3MrKzt0cnl7Zm9yKHZhciBuPXRoaXMudDt2b2lkIDAhPT1uO249bi54KW4udC5OKCl9ZmluYWxseXt0KCl9fX19KTtmdW5jdGlvbiB5KGksdCl7cmV0dXJuIG5ldyBsKGksdCl9ZnVuY3Rpb24gdyhpKXtmb3IodmFyIHQ9aS5zO3ZvaWQgMCE9PXQ7dD10Lm4paWYodC5TLmkhPT10Lml8fCF0LlMuaCgpfHx0LlMuaSE9PXQuaSlyZXR1cm4hMDtyZXR1cm4hMX1mdW5jdGlvbiBfKGkpe2Zvcih2YXIgdD1pLnM7dm9pZCAwIT09dDt0PXQubil7dmFyIG49dC5TLm47aWYodm9pZCAwIT09bil0LnI9bjt0LlMubj10O3QuaT0tMTtpZih2b2lkIDA9PT10Lm4pe2kucz10O2JyZWFrfX19ZnVuY3Rpb24gYihpKXt2YXIgdD1pLnMsbj12b2lkIDA7d2hpbGUodm9pZCAwIT09dCl7dmFyIHI9dC5wO2lmKC0xPT09dC5pKXt0LlMuVSh0KTtpZih2b2lkIDAhPT1yKXIubj10Lm47aWYodm9pZCAwIT09dC5uKXQubi5wPXJ9ZWxzZSBuPXQ7dC5TLm49dC5yO2lmKHZvaWQgMCE9PXQucil0LnI9dm9pZCAwO3Q9cn1pLnM9bn1mdW5jdGlvbiBwKGksdCl7bC5jYWxsKHRoaXMsdm9pZCAwKTt0aGlzLng9aTt0aGlzLnM9dm9pZCAwO3RoaXMuZz1jLTE7dGhpcy5mPTQ7dGhpcy5XPW51bGw9PXQ/dm9pZCAwOnQud2F0Y2hlZDt0aGlzLlo9bnVsbD09dD92b2lkIDA6dC51bndhdGNoZWQ7dGhpcy5uYW1lPW51bGw9PXQ/dm9pZCAwOnQubmFtZX1wLnByb3RvdHlwZT1uZXcgbDtwLnByb3RvdHlwZS5oPWZ1bmN0aW9uKCl7dGhpcy5mJj0tMztpZigxJnRoaXMuZilyZXR1cm4hMTtpZigzMj09KDM2JnRoaXMuZikpcmV0dXJuITA7dGhpcy5mJj0tNTtpZih0aGlzLmc9PT1jKXJldHVybiEwO3RoaXMuZz1jO3RoaXMuZnw9MTtpZih0aGlzLmk+MCYmIXcodGhpcykpe3RoaXMuZiY9LTI7cmV0dXJuITB9dmFyIGk9cjt0cnl7Xyh0aGlzKTtyPXRoaXM7dmFyIHQ9dGhpcy54KCk7aWYoMTYmdGhpcy5mfHx0aGlzLnYhPT10fHwwPT09dGhpcy5pKXt0aGlzLnY9dDt0aGlzLmYmPS0xNzt0aGlzLmkrK319Y2F0Y2goaSl7dGhpcy52PWk7dGhpcy5mfD0xNjt0aGlzLmkrK31yPWk7Yih0aGlzKTt0aGlzLmYmPS0yO3JldHVybiEwfTtwLnByb3RvdHlwZS5TPWZ1bmN0aW9uKGkpe2lmKHZvaWQgMD09PXRoaXMudCl7dGhpcy5mfD0zNjtmb3IodmFyIHQ9dGhpcy5zO3ZvaWQgMCE9PXQ7dD10Lm4pdC5TLlModCl9bC5wcm90b3R5cGUuUy5jYWxsKHRoaXMsaSl9O3AucHJvdG90eXBlLlU9ZnVuY3Rpb24oaSl7aWYodm9pZCAwIT09dGhpcy50KXtsLnByb3RvdHlwZS5VLmNhbGwodGhpcyxpKTtpZih2b2lkIDA9PT10aGlzLnQpe3RoaXMuZiY9LTMzO2Zvcih2YXIgdD10aGlzLnM7dm9pZCAwIT09dDt0PXQubil0LlMuVSh0KX19fTtwLnByb3RvdHlwZS5OPWZ1bmN0aW9uKCl7aWYoISgyJnRoaXMuZikpe3RoaXMuZnw9Njtmb3IodmFyIGk9dGhpcy50O3ZvaWQgMCE9PWk7aT1pLngpaS50Lk4oKX19O09iamVjdC5kZWZpbmVQcm9wZXJ0eShwLnByb3RvdHlwZSxcInZhbHVlXCIse2dldDpmdW5jdGlvbigpe2lmKDEmdGhpcy5mKXRocm93IG5ldyBFcnJvcihcIkN5Y2xlIGRldGVjdGVkXCIpO3ZhciBpPWEodGhpcyk7dGhpcy5oKCk7aWYodm9pZCAwIT09aSlpLmk9dGhpcy5pO2lmKDE2JnRoaXMuZil0aHJvdyB0aGlzLnY7cmV0dXJuIHRoaXMudn19KTtmdW5jdGlvbiBnKGksdCl7cmV0dXJuIG5ldyBwKGksdCl9ZnVuY3Rpb24gUyhpKXt2YXIgbj1pLm07aS5tPXZvaWQgMDtpZihcImZ1bmN0aW9uXCI9PXR5cGVvZiBuKXtzKys7dmFyIG89cjtyPXZvaWQgMDt0cnl7bigpfWNhdGNoKHQpe2kuZiY9LTI7aS5mfD04O20oaSk7dGhyb3cgdH1maW5hbGx5e3I9bzt0KCl9fX1mdW5jdGlvbiBtKGkpe2Zvcih2YXIgdD1pLnM7dm9pZCAwIT09dDt0PXQubil0LlMuVSh0KTtpLng9dm9pZCAwO2kucz12b2lkIDA7UyhpKX1mdW5jdGlvbiB4KGkpe2lmKHIhPT10aGlzKXRocm93IG5ldyBFcnJvcihcIk91dC1vZi1vcmRlciBlZmZlY3RcIik7Yih0aGlzKTtyPWk7dGhpcy5mJj0tMjtpZig4JnRoaXMuZiltKHRoaXMpO3QoKX1mdW5jdGlvbiBFKGksdCl7dGhpcy54PWk7dGhpcy5tPXZvaWQgMDt0aGlzLnM9dm9pZCAwO3RoaXMudT12b2lkIDA7dGhpcy5mPTMyO3RoaXMubmFtZT1udWxsPT10P3ZvaWQgMDp0Lm5hbWU7aWYoZilmLnB1c2godGhpcyl9RS5wcm90b3R5cGUuYz1mdW5jdGlvbigpe3ZhciBpPXRoaXMuUygpO3RyeXtpZig4JnRoaXMuZilyZXR1cm47aWYodm9pZCAwPT09dGhpcy54KXJldHVybjt2YXIgdD10aGlzLngoKTtpZihcImZ1bmN0aW9uXCI9PXR5cGVvZiB0KXRoaXMubT10fWZpbmFsbHl7aSgpfX07RS5wcm90b3R5cGUuUz1mdW5jdGlvbigpe2lmKDEmdGhpcy5mKXRocm93IG5ldyBFcnJvcihcIkN5Y2xlIGRldGVjdGVkXCIpO3RoaXMuZnw9MTt0aGlzLmYmPS05O1ModGhpcyk7Xyh0aGlzKTtzKys7dmFyIGk9cjtyPXRoaXM7cmV0dXJuIHguYmluZCh0aGlzLGkpfTtFLnByb3RvdHlwZS5OPWZ1bmN0aW9uKCl7aWYoISgyJnRoaXMuZikpe3RoaXMuZnw9Mjt0aGlzLnU9aDtoPXRoaXN9fTtFLnByb3RvdHlwZS5kPWZ1bmN0aW9uKCl7dGhpcy5mfD04O2lmKCEoMSZ0aGlzLmYpKW0odGhpcyl9O0UucHJvdG90eXBlLmRpc3Bvc2U9ZnVuY3Rpb24oKXt0aGlzLmQoKX07ZnVuY3Rpb24gQyhpLHQpe3ZhciBuPW5ldyBFKGksdCk7dHJ5e24uYygpfWNhdGNoKGkpe24uZCgpO3Rocm93IGl9dmFyIHI9bi5kLmJpbmQobik7cltTeW1ib2wuZGlzcG9zZV09cjtyZXR1cm4gcn1mdW5jdGlvbiBPKGkpe3JldHVybiBmdW5jdGlvbigpe3ZhciB0PWFyZ3VtZW50cyxyPXRoaXM7cmV0dXJuIG4oZnVuY3Rpb24oKXtyZXR1cm4gbyhmdW5jdGlvbigpe3JldHVybiBpLmFwcGx5KHIsW10uc2xpY2UuY2FsbCh0KSl9KX0pfX1mdW5jdGlvbiBqKCl7dmFyIGk9ZjtmPVtdO3JldHVybiBmdW5jdGlvbigpe3ZhciB0PWY7aWYoZiYmaSlpPWkuY29uY2F0KGYpO2Y9aTtyZXR1cm4gdH19ZnVuY3Rpb24gayhpKXtyZXR1cm4gZnVuY3Rpb24oKXt2YXIgdCxuLHI9aigpO3RyeXtuPWkuYXBwbHkodm9pZCAwLFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSl9Y2F0Y2goaSl7Zj12b2lkIDA7dGhyb3cgaX1maW5hbGx5e3Q9cigpfWZvcih2YXIgbyBpbiBuKWlmKFwiZnVuY3Rpb25cIj09dHlwZW9mIG5bb10pbltvXT1PKG5bb10pO25bU3ltYm9sLmRpc3Bvc2VdPU8oZnVuY3Rpb24oKXtpZih0KWZvcih2YXIgaT0wO2k8dC5sZW5ndGg7aSsrKXRbaV0uZGlzcG9zZSgpO3Q9dm9pZCAwfSk7cmV0dXJuIG59fWV4cG9ydHtwIGFzIENvbXB1dGVkLEUgYXMgRWZmZWN0LGwgYXMgU2lnbmFsLE8gYXMgYWN0aW9uLG4gYXMgYmF0Y2gsZyBhcyBjb21wdXRlZCxrIGFzIGNyZWF0ZU1vZGVsLEMgYXMgZWZmZWN0LHkgYXMgc2lnbmFsLG8gYXMgdW50cmFja2VkfTsvLyMgc291cmNlTWFwcGluZ1VSTD1zaWduYWxzLWNvcmUubW9kdWxlLmpzLm1hcFxuIiwKICAgICJpbXBvcnR7U2lnbmFsIGFzIG59ZnJvbVwiQHByZWFjdC9zaWduYWxzLWNvcmVcIjtpbXBvcnR7dXNlU2lnbmFsfWZyb21cIkBwcmVhY3Qvc2lnbmFsc1wiO2ltcG9ydHtjcmVhdGVFbGVtZW50IGFzIHIsRnJhZ21lbnQgYXMgdH1mcm9tXCJwcmVhY3RcIjtpbXBvcnR7dXNlTWVtbyBhcyBlfWZyb21cInByZWFjdC9ob29rc1wiO3ZhciBpPWZ1bmN0aW9uKG4pe3JldHVyblwiZnVuY3Rpb25cIj09dHlwZW9mIG4uY2hpbGRyZW4/bi5jaGlsZHJlbihuLnYsbi5pKTpuLmNoaWxkcmVufTtpLmRpc3BsYXlOYW1lPVwiSXRlbVwiO2Z1bmN0aW9uIG8obil7dmFyIHQ9XCJmdW5jdGlvblwiPT10eXBlb2Ygbi53aGVuP24ud2hlbigpOm4ud2hlbi52YWx1ZTtpZighdClyZXR1cm4gbi5mYWxsYmFja3x8bnVsbDtlbHNlIHJldHVybiByKGkse3Y6dCxjaGlsZHJlbjpuLmNoaWxkcmVufSl9by5kaXNwbGF5TmFtZT1cIlNob3dcIjtmdW5jdGlvbiB1KG8pe3ZhciB1PWUoZnVuY3Rpb24oKXtyZXR1cm4gbmV3IE1hcH0sW10pLGY9XCJmdW5jdGlvblwiPT10eXBlb2Ygby5lYWNoP28uZWFjaCgpOm8uZWFjaCxjPWYgaW5zdGFuY2VvZiBuP2YudmFsdWU6ZjtpZighYy5sZW5ndGgpcmV0dXJuIG8uZmFsbGJhY2t8fG51bGw7dmFyIGE9bmV3IFNldCh1LmtleXMoKSkscD1jLm1hcChmdW5jdGlvbihuLHQpe2EuZGVsZXRlKG4pO2lmKCF1LmhhcyhuKSl7dmFyIGU9cihpLHt2Om4saTp0LGNoaWxkcmVuOm8uY2hpbGRyZW59KTt1LnNldChuLGUpO3JldHVybiBlfXJldHVybiB1LmdldChuKX0pO2EuZm9yRWFjaChmdW5jdGlvbihuKXt1LmRlbGV0ZShuKX0pO3JldHVybiByKHQsbnVsbCxwKX11LmRpc3BsYXlOYW1lPVwiRm9yXCI7ZnVuY3Rpb24gZihuKXt2YXIgcj11c2VTaWduYWwobik7aWYoci5wZWVrKCkhPT1uKXIudmFsdWU9bjtyZXR1cm4gcn1mdW5jdGlvbiBjKG4pe3ZhciByPXVzZVNpZ25hbChuKTtpZighKFwiY3VycmVudFwiaW4gcikpT2JqZWN0LmRlZmluZVByb3BlcnR5KHIsXCJjdXJyZW50XCIsYSk7cmV0dXJuIHJ9dmFyIGE9e2NvbmZpZ3VyYWJsZTohMCxnZXQ6ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy52YWx1ZX0sc2V0OmZ1bmN0aW9uKG4pe3RoaXMudmFsdWU9bn19O2V4cG9ydHt1IGFzIEZvcixvIGFzIFNob3csZiBhcyB1c2VMaXZlU2lnbmFsLGMgYXMgdXNlU2lnbmFsUmVmfTsvLyMgc291cmNlTWFwcGluZ1VSTD11dGlscy5tb2R1bGUuanMubWFwXG4iLAogICAgImltcG9ydHtvcHRpb25zIGFzIHIsRnJhZ21lbnQgYXMgZX1mcm9tXCJwcmVhY3RcIjtleHBvcnR7RnJhZ21lbnR9ZnJvbVwicHJlYWN0XCI7dmFyIHQ9L1tcIiY8XS87ZnVuY3Rpb24gbihyKXtpZigwPT09ci5sZW5ndGh8fCExPT09dC50ZXN0KHIpKXJldHVybiByO2Zvcih2YXIgZT0wLG49MCxvPVwiXCIsZj1cIlwiO248ci5sZW5ndGg7bisrKXtzd2l0Y2goci5jaGFyQ29kZUF0KG4pKXtjYXNlIDM0OmY9XCImcXVvdDtcIjticmVhaztjYXNlIDM4OmY9XCImYW1wO1wiO2JyZWFrO2Nhc2UgNjA6Zj1cIiZsdDtcIjticmVhaztkZWZhdWx0OmNvbnRpbnVlfW4hPT1lJiYobys9ci5zbGljZShlLG4pKSxvKz1mLGU9bisxfXJldHVybiBuIT09ZSYmKG8rPXIuc2xpY2UoZSxuKSksb312YXIgbz0vYWNpdHxleCg/OnN8Z3xufHB8JCl8cnBofGdyaWR8b3dzfG1uY3xudHd8aW5lW2NoXXx6b298Xm9yZHxpdGVyYS9pLGY9MCxpPUFycmF5LmlzQXJyYXk7ZnVuY3Rpb24gdShlLHQsbixvLGksdSl7dHx8KHQ9e30pO3ZhciBhLGMscD10O2lmKFwicmVmXCJpbiBwKWZvcihjIGluIHA9e30sdClcInJlZlwiPT1jP2E9dFtjXTpwW2NdPXRbY107dmFyIGw9e3R5cGU6ZSxwcm9wczpwLGtleTpuLHJlZjphLF9fazpudWxsLF9fOm51bGwsX19iOjAsX19lOm51bGwsX19jOm51bGwsY29uc3RydWN0b3I6dm9pZCAwLF9fdjotLWYsX19pOi0xLF9fdTowLF9fc291cmNlOmksX19zZWxmOnV9O2lmKFwiZnVuY3Rpb25cIj09dHlwZW9mIGUmJihhPWUuZGVmYXVsdFByb3BzKSlmb3IoYyBpbiBhKXZvaWQgMD09PXBbY10mJihwW2NdPWFbY10pO3JldHVybiByLnZub2RlJiZyLnZub2RlKGwpLGx9ZnVuY3Rpb24gYShyKXt2YXIgdD11KGUse3RwbDpyLGV4cHJzOltdLnNsaWNlLmNhbGwoYXJndW1lbnRzLDEpfSk7cmV0dXJuIHQua2V5PXQuX192LHR9dmFyIGM9e30scD0vW0EtWl0vZztmdW5jdGlvbiBsKGUsdCl7aWYoci5hdHRyKXt2YXIgZj1yLmF0dHIoZSx0KTtpZihcInN0cmluZ1wiPT10eXBlb2YgZilyZXR1cm4gZn1pZih0PWZ1bmN0aW9uKHIpe3JldHVybiBudWxsIT09ciYmXCJvYmplY3RcIj09dHlwZW9mIHImJlwiZnVuY3Rpb25cIj09dHlwZW9mIHIudmFsdWVPZj9yLnZhbHVlT2YoKTpyfSh0KSxcInJlZlwiPT09ZXx8XCJrZXlcIj09PWUpcmV0dXJuXCJcIjtpZihcInN0eWxlXCI9PT1lJiZcIm9iamVjdFwiPT10eXBlb2YgdCl7dmFyIGk9XCJcIjtmb3IodmFyIHUgaW4gdCl7dmFyIGE9dFt1XTtpZihudWxsIT1hJiZcIlwiIT09YSl7dmFyIGw9XCItXCI9PXVbMF0/dTpjW3VdfHwoY1t1XT11LnJlcGxhY2UocCxcIi0kJlwiKS50b0xvd2VyQ2FzZSgpKSxzPVwiO1wiO1wibnVtYmVyXCIhPXR5cGVvZiBhfHxsLnN0YXJ0c1dpdGgoXCItLVwiKXx8by50ZXN0KGwpfHwocz1cInB4O1wiKSxpPWkrbCtcIjpcIithK3N9fXJldHVybiBlKyc9XCInK24oaSkrJ1wiJ31yZXR1cm4gbnVsbD09dHx8ITE9PT10fHxcImZ1bmN0aW9uXCI9PXR5cGVvZiB0fHxcIm9iamVjdFwiPT10eXBlb2YgdD9cIlwiOiEwPT09dD9lOmUrJz1cIicrbihcIlwiK3QpKydcIid9ZnVuY3Rpb24gcyhyKXtpZihudWxsPT1yfHxcImJvb2xlYW5cIj09dHlwZW9mIHJ8fFwiZnVuY3Rpb25cIj09dHlwZW9mIHIpcmV0dXJuIG51bGw7aWYoXCJvYmplY3RcIj09dHlwZW9mIHIpe2lmKHZvaWQgMD09PXIuY29uc3RydWN0b3IpcmV0dXJuIHI7aWYoaShyKSl7Zm9yKHZhciBlPTA7ZTxyLmxlbmd0aDtlKyspcltlXT1zKHJbZV0pO3JldHVybiByfX1yZXR1cm4gbihcIlwiK3IpfWV4cG9ydHt1IGFzIGpzeCxsIGFzIGpzeEF0dHIsdSBhcyBqc3hERVYscyBhcyBqc3hFc2NhcGUsYSBhcyBqc3hUZW1wbGF0ZSx1IGFzIGpzeHN9O1xuLy8jIHNvdXJjZU1hcHBpbmdVUkw9anN4UnVudGltZS5tb2R1bGUuanMubWFwXG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztFQUE4SCxTQUFTLENBQUMsQ0FBQyxJ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QUFFLEtBQUcsTUFBSyxHQUFFLE9BQUssTUFBRyxFQUFFLEVBQUM7QUFBQSxJQUFDO0FBQUE7QUFBQSxFQUFFLFNBQVMsQ0FBQyxDQUFDLElBQUU7QUFBQSxJQUFDLEtBQVUsS0FBRSxHQUFFLE9BQVgsUUFBc0IsR0FBRSxPQUFSO0FBQUEsTUFBWSxPQUFPLEdBQUUsTUFBSSxHQUFFLElBQUksT0FBSyxNQUFLLEdBQUUsSUFBSSxLQUFLLFFBQVEsQ0FBQyxJQUFFO0FBQUEsUUFBQyxJQUFTLE1BQU4sUUFBZSxHQUFFLE9BQVI7QUFBQSxVQUFZLE9BQU8sR0FBRSxNQUFJLEdBQUUsSUFBSSxPQUFLLEdBQUU7QUFBQSxPQUFJLEdBQUUsRUFBRSxFQUFDO0FBQUE7QUFBQSxFQUFFLFNBQVMsQ0FBQyxDQUFDLElBQUU7QUFBQSxLQUFFLENBQUMsR0FBRSxRQUFNLEdBQUUsTUFBSSxTQUFLLEVBQUUsS0FBSyxFQUFDLEtBQUcsQ0FBQyxFQUFFLFNBQU8sS0FBRyxFQUFFLHdCQUFzQixJQUFFLEVBQUUsc0JBQW9CLEdBQUcsQ0FBQztBQUFBO0FBQUEsRUFBRSxTQUFTLENBQUMsR0FBRTtBQUFBLElBQUMsSUFBRztBQUFBLE1BQUMsU0FBUSxJQUFFLEtBQUUsRUFBRSxFQUFFO0FBQUEsUUFBUSxFQUFFLFNBQU8sTUFBRyxFQUFFLEtBQUssQ0FBQyxHQUFFLEtBQUUsRUFBRSxNQUFNLEdBQUUsS0FBRSxFQUFFLFFBQU8sRUFBRSxFQUFDO0FBQUEsY0FBRTtBQUFBLE1BQVEsRUFBRSxTQUFPLEVBQUUsTUFBSTtBQUFBO0FBQUE7QUFBQSxFQUFHLFNBQVMsQ0FBQyxDQUFDLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRTtBQUFBLElBQUMsSUFBSSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLEtBQUUsTUFBRyxHQUFFLE9BQUssR0FBRSxLQUFFLEdBQUU7QUFBQSxJQUFPLEtBQUksS0FBRSxFQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsRUFBQyxH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T0FBTSxJQUFFO0FBQUEsVUFBQyxJQUFHLEdBQUUsTUFBSSxNQUFLLE1BQVMsTUFBTjtBQUFBLFlBQVEsSUFBRyxHQUFFLE1BQUs7QUFBQSxjQUFDLEtBQUksR0FBRSxPQUFLLEtBQUUsTUFBSSxJQUFJLE1BQU0sR0FBRSxZQUFMLEtBQWUsR0FBRTtBQUFBLGdCQUFhLEtBQUUsR0FBRTtBQUFBLGNBQVksR0FBRSxHQUFFLFFBQVEsRUFBQyxLQUFHLE1BQUssR0FBRSxNQUFJO0FBQUEsWUFBQyxFQUFLO0FBQUEsY0FBQyxLQUFJLEtBQUUsR0FBRSxPQUFPO0FBQUEsZ0JBQUssRUFBRSxHQUFFLEdBQUU7QUFBQSxjQUFFLEVBQUUsRUFBQztBQUFBO0FBQUEsVUFBTztBQUFBLGVBQUUsTUFBSSxHQUFFLEtBQUksR0FBRSxNQUFJLEdBQUUsS0FBSSxHQUFFLFFBQU0sRUFBRSxFQUFDO0FBQUEsVUFBRSxFQUFFLElBQUksSUFBRSxJQUFFLEVBQUM7QUFBQTtBQUFBLE1BQU87QUFBQSxRQUFNLE1BQU4sUUFBUyxHQUFFLE9BQUssR0FBRSxPQUFLLEdBQUUsTUFBSSxHQUFFLEtBQUksR0FBRSxNQUFJLEdBQUUsT0FBSyxLQUFFLEdBQUUsTUFBSSxFQUFFLEdBQUUsS0FBSSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLEVBQUM7QUFBQSxJQUFFLFFBQU8sS0FBRSxFQUFFLFdBQVMsR0FBRSxFQUFDLEdBQUUsTUFBSSxHQUFFLE1BQVMsWUFBRTtBQUFBO0FBQUEsRUFBRSxTQUFTLENBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxPQUFJLEdBQUUsUUFBTSxHQUFFLElBQUksTUFBSSxPQUFJLEdBQUUsT0FBSyxHQUFFLElBQUksS0FBSyxDQUFDO0FBQUE7QUFBQSxFQUFHLFNBQVMsQ0FBQyxDQUFDLElBQUUsSUFBRSxJQUFFO0FBQUEsSUFBQyxTQUFRLEtBQUUsRUFBRSxLQUFFLEdBQUUsUUFBTztBQUFBLE1BQUksRUFBRSxHQUFFLEtBQUcsR0FBRSxFQUFFLEtBQUcsR0FBRSxFQUFFLEdBQUU7QUFB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SSxHQUFFLEVBQUMsQ0FBQztBQUFBLEtBQUcsUUFBUSxHQUFFO0FBQUEsS0FBRSxRQUFRLEdBQUU7QUFBQSxNQUFDLElBQUksS0FBRSxFQUFFLEtBQUksS0FBRSxFQUFFLFFBQU8sS0FBRSxFQUFFLElBQUcsS0FBRSxFQUFFLE9BQU0sS0FBRSxFQUFFO0FBQUEsTUFBSSxFQUFFLFNBQU8sUUFBUSxDQUFDLElBQUU7QUFBQSxRQUFDLEdBQUUsRUFBQyxLQUFHLEdBQUUsSUFBSSxHQUFFLEdBQUUsSUFBSSxHQUFFLE1BQUcsR0FBRSxFQUFDO0FBQUEsU0FBRyxFQUFFLE1BQUksUUFBUSxDQUFDLElBQUU7QUFBQSxRQUFDLEdBQUUsRUFBQyxLQUFHLEdBQUUsS0FBSyxFQUFDLEdBQUUsTUFBRyxHQUFFLEVBQUM7QUFBQSxTQUFHLEVBQUUsS0FBRyxRQUFRLENBQUMsSUFBRSxJQUFFO0FBQUEsUUFBQyxLQUFFLENBQUMsR0FBRSxNQUFHLEdBQUUsSUFBRSxFQUFDO0FBQUEsU0FBRyxFQUFFLFFBQU0sUUFBUSxDQUFDLElBQUU7QUFBQSxRQUFDLEdBQUUsTUFBSSxHQUFFLFNBQU8sSUFBRSxHQUFFLEdBQUUsU0FBTyxLQUFHLE1BQUssTUFBRyxHQUFFLEVBQUM7QUFBQSxTQUFHLEVBQUUsTUFBSSxRQUFRLENBQUMsSUFBRTtBQUFBLFFBQUMsR0FBRSxFQUFDLEtBQUcsR0FBRSxLQUFLLEVBQUMsR0FBRSxNQUFHLEdBQUUsRUFBQztBQUFBO0FBQUEsT0FBSTtBQUFBLElBQUUsSUFBSSxLQUFFLE9BQUcsS0FBRSxFQUFFLEtBQUksS0FBRSxFQUFFLFFBQU8sS0FBRSxFQUFFLE9BQU0sS0FBRSxFQUFFLEtBQUksS0FBRSxFQUFFLEtBQUksS0FBRSxFQUFFLElBQUcsS0FBRSxFQUFFLEtBQUksS0FBRSxLQUFFLEVBQUMsV0FBVSxJQUFJLFNBQVEsaUJBQWdCLElBQUksU0FBUSxlQUFjLElBQUksUUFBTyxJQUFFLE1BQUssS0FBRSxDQUFDO0FBQUEsSUFBRSxFQUFFLE1BQUksUUFBUSxDQUFDLElBQUUsSUFBRSxJ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QUFOLElBQVE7QUFBQSxFQUFSLElBQVU7QUFBQSxFQUFWLElBQVksS0FBRTtBQUFBLEVBQWQsSUFBZ0IsS0FBRSxDQUFDO0FBQUEsRUFBbkIsSUFBcUIsS0FBRTtBQUFBLEVBQXZCLElBQXlCLEtBQUUsR0FBRTtBQUFBLEVBQTdCLElBQWlDLEtBQUUsR0FBRTtBQUFBLEVBQXJDLElBQXlDLEtBQUUsR0FBRTtBQUFBLEVBQTdDLElBQW9ELEtBQUUsR0FBRTtBQUFBLEVBQXhELElBQTRELEtBQUUsR0FBRTtBQUFBLEVBQWhFLElBQXdFLEtBQUUsR0FBRTtBQUFBLEVBQUcsU0FBUyxFQUFDLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxHQUFFLE9BQUssR0FBRSxJQUFJLElBQUUsSUFBRSxNQUFHLEVBQUMsR0FBRSxLQUFFO0FBQUEsSUFBRSxJQUFJLEtBQUUsR0FBRSxRQUFNLEdBQUUsTUFBSSxFQUFDLElBQUcsQ0FBQyxHQUFFLEtBQUksQ0FBQyxFQUFDO0FBQUEsSUFBRyxPQUFPLE1BQUcsR0FBRSxHQUFHLFVBQVEsR0FBRSxHQUFHLEtBQUssQ0FBQyxDQUFDLEdBQUUsR0FBRSxHQUFHO0FBQUE7QUFBQSxFQUFHLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLE9BQU8sS0FBRSxHQUFFLEdBQUUsSUFBRSxFQUFDO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUUsSUFBRSxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsR0FBRSxNQUFJLENBQUM7QUFBQSxJQUFFLElBQUcsR0FBRSxJQUFFLElBQUUsQ0FBQyxHQUFFLFFBQU0sR0FBRSxLQUFHLENBQUMsS0FBRSxHQUFFLEVBQUMsSUFBRSxHQUFPLFdBQUUsRUFBQyxHQUFFLFFBQVEsQ0FBQyxJQUFFO0FBQUEsTUFBQyxJQUFJLEtBQUUsR0FBRSxNQUFJLEdBQUUsSUFBSSxLQUFHLEdBQUUsR0FBRyxJQUFHLEtBQUUsR0FBRSxFQUFFLElBQUUsRUFBQztBQUFBLE1BQUUsT0FBSSxPQUFJLEdBQUUsTUFBSSxDQUFDLElBQUUsR0FBRSxHQUFHLEVBQUUsR0FBRSxHQUFFLElBQUksU0FBUyxDQUFDLENBQUM7QUFBQSxLQUFHLEdBQUUsR0FBRSxNQUFJLElBQUUsQ0FBQyxHQUFFLE1BQUs7QUFBQSxNQUFDLElBQUksS0FBRSxRQUFRLENBQUMsSUFBRSxJQUFFLElBQUU7QUFBQSxRQUFDLElBQUcsQ0FBQyxHQUFFLElBQUk7QUFBQSxVQUFJLE9BQU07QUFBQSxRQUFHLElBQUksS0FBRSxHQUFFLElBQUksSUFBSSxHQUFHLE9BQU8sUUFBUSxDQUFDLElBQUU7QUFBQSxVQUFDLE9BQU8sR0FBRTtBQUFBLFNBQUk7QUFBQSxRQUFFLElBQUcsR0FBRSxNQUFNLFFBQVEsQ0FBQyxJQUFFO0FBQUEsVUFBQyxPQUFNLENBQUMsR0FBRTtBQUFBLFNBQUk7QUFBQSxVQUFFLE9BQU0sQ0FBQyxNQUFHLEdBQUUsS0FBSyxNQUFLLElBQUUsSUFBRSxFQUFDO0FBQUEsUUFBRSxJQUFJLEtBQUUsR0FBRSxJQUFJLFVBQVE7QUFBQSxRQUFFLE9BQU8sR0FBRSxLQUFLLFFBQVEsQ0FBQyxJQUFFO0FBQUEsVUFBQyxJQUFHLEdBQUUsS0FBSTtBQUFBLFlBQUMsSUFBSSxLQUFFLEdBQUUsR0FBRztBQUFBLFlBQUcsR0FBRSxLQUFHLEdBQUUsS0FBSSxHQUFFLE1BQVMsV0FBRSxPQUFJLEdBQUUsR0FBRyxPQUFLLEtBQUU7QUFBQSxVQUFHO0FBQUEsU0FBRSxHQUFFLE1BQUcsR0FBRSxLQUFLLE1BQUssSUFBRSxJQUFFLEVBQUMsS0FBRztBQUFBO0FBQUEsTUFBRyxHQUFFLE1BQUk7QUFBQSxNQUFHLE1BQVEsdUJBQUosSUFBOEIscUJBQUosT0FBRTtBQUFBLE1BQXNCLEdBQUUsc0JBQW9CLFFBQVEsQ0FBQyxJQUFFLElBQUUsSUFBRTtBQUFBLFFBQUMsSUFBRyxLQUFLLEtBQUk7QUFBQSxVQUFDLElBQUksS0FBRTtBQUFBLFVBQUUsS0FBTyxXQUFFLEdBQUUsSUFBRSxJQUFFLEVBQUMsR0FBRSxLQUFFO0FBQUEsUUFBQztBQUFBLFFBQUMsTUFBRyxHQUFFLEtBQUssTUFBSyxJQUFFLElBQUUsRUFBQztBQUFBLFNBQUcsR0FBRSx3QkFBc0I7QUFBQSxJQUFDO0FBQUEsSUFBQyxPQUFPLEdBQUUsT0FBSyxHQUFFO0FBQUE7QUFBQSxFQUFHLFNBQVMsRUFBQyxDQUFDLElBQUUsSUFBRTtBQUFBLElBQUMsSUFBSSxLQUFFLEdBQUUsTUFBSSxDQUFDO0FBQUEsSUFBRSxDQUFDLEdBQUUsT0FBSyxHQUFFLEdBQUUsS0FBSSxFQUFDLE1BQUksR0FBRSxLQUFHLElBQUUsR0FBRSxJQUFFLElBQUUsR0FBRSxJQUFJLElBQUksS0FBSyxFQUFDO0FBQUE7RUFBbUYsU0FBUyxFQUFDLENBQUMsSUFBRTtBQUFBLElBQUMsT0FBTyxLQUFFLEdBQUUsR0FBRSxRQUFRLEdBQUU7QUFBQSxNQUFDLE9BQU0sRUFBQyxTQUFRLEdBQUM7QUFBQSxPQUFHLENBQUMsQ0FBQztBQUFBO0VBQXVOLFNBQVMsRUFBQyxDQUFDLElBQUUsSUFBRTtBQUFBLElBQUMsSUFBSSxLQUFFLEdBQUUsTUFBSSxDQUFDO0FBQUEsSUFBRSxPQUFPLEdBQUUsR0FBRSxLQUFJLEVBQUMsTUFBSSxHQUFFLEtBQUcsR0FBRSxHQUFFLEdBQUUsTUFBSSxJQUFFLEdBQUUsTUFBSSxLQUFHLEdBQUU7QUFBQTtFQUF1aUIsU0FBUyxFQUFDLEdBQUU7QUFBQSxJQUFDLFNBQVEsR0FBRSxLQUFFLEdBQUUsTUFBTSxLQUFHO0FBQUEsTUFBQyxJQUFJLEtBQUUsR0FBRTtBQUFBLE1BQUksSUFBRyxHQUFFLE9BQUs7QUFBQSxRQUFFLElBQUc7QUFBQSxVQUFDLEdBQUUsSUFBSSxLQUFLLEVBQUMsR0FBRSxHQUFFLElBQUksS0FBSyxFQUFDLEdBQUUsR0FBRSxNQUFJLENBQUM7QUFBQSxVQUFFLE9BQU0sSUFBRTtBQUFBLFVBQUMsR0FBRSxNQUFJLENBQUMsR0FBRSxHQUFFLElBQUksSUFBRSxHQUFFLEdBQUc7QUFBQTtBQUFBLElBQUU7QUFBQTtBQUFBLEVBQUUsR0FBRSxNQUFJLFFBQVEsQ0FBQyxJQUFFO0FBQUEsSUFBQyxLQUFFLE1BQUssTUFBRyxHQUFFLEVBQUM7QUFBQSxLQUFHLEdBQUUsS0FBRyxRQUFRLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxNQUFHLEdBQUUsT0FBSyxHQUFFLElBQUksUUFBTSxHQUFFLE1BQUksR0FBRSxJQUFJLE1BQUssTUFBRyxHQUFFLElBQUUsRUFBQztBQUFBLEtBQUcsR0FBRSxNQUFJLFFBQVEsQ0FBQyxJQUFFO0FBQUEsSUFBQyxNQUFHLEdBQUUsRUFBQyxHQUFFLEtBQUU7QUFBQSxJQUFFLElBQUksTUFBRyxLQUFFLEdBQUUsS0FBSztBQUFBLElBQUksT0FBSSxPQUFJLE1BQUcsR0FBRSxNQUFJLENBQUMsR0FBRSxHQUFFLE1BQUksQ0FBQyxHQUFFLEdBQUUsR0FBRyxLQUFLLFFBQVEsQ0FBQyxJQUFFO0FBQUEsTUFBQyxHQUFFLFFBQU0sR0FBRSxLQUFHLEdBQUUsTUFBSyxHQUFFLElBQUUsR0FBRSxNQUFTO0FBQUEsS0FBRSxNQUFJLEdBQUUsSUFBSSxLQUFLLEVBQUMsR0FBRSxHQUFFLElBQUksS0FBSyxFQUFDLEdBQUUsR0FBRSxNQUFJLENBQUMsR0FBRSxLQUFFLEtBQUksS0FBRTtBQUFBLEtBQUcsR0FBRSxTQUFPLFFBQVEsQ0FBQyxJQUFFO0FBQUEsSUFBQyxNQUFHLEdBQUUsRUFBQztBQUFBLElBQUUsSUFBSSxLQUFFLEdBQUU7QUFBQSxJQUFJLE1BQUcsR0FBRSxRQUFNLEdBQUUsSUFBSSxJQUFJLFdBQWEsR0FBRSxLQUFLLEVBQUMsTUFBWixLQUFlLE9BQUksR0FBRSwyQkFBeUIsS0FBRSxHQUFFLDBCQUF3QixJQUFHLEVBQUMsSUFBRyxHQUFFLElBQUksR0FBRyxLQUFLLFFBQVEsQ0FBQyxJQUFFO0FBQUEsTUFBQyxHQUFFLE1BQUksR0FBRSxNQUFJLEdBQUUsSUFBRyxHQUFFLElBQU87QUFBQSxLQUFFLElBQUcsS0FBRSxLQUFFO0FBQUEsS0FBTSxHQUFFLE1BQUksUUFBUSxDQUFDLElBQUUsSUFBRTtBQUFBLElBQUMsR0FBRSxLQUFLLFFBQVEsQ0FBQyxJQUFFO0FBQUEsTUFBQyxJQUFHO0FBQUEsUUFBQyxHQUFFLElBQUksS0FBSyxFQUFDLEdBQUUsR0FBRSxNQUFJLEdBQUUsSUFBSSxPQUFPLFFBQVEsQ0FBQyxJQUFFO0FBQUEsVUFBQyxPQUFNLENBQUMsR0FBRSxNQUFJLEdBQUUsRUFBQztBQUFBLFNBQUU7QUFBQSxRQUFFLE9BQU0sSUFBRTtBQUFBLFFBQUMsR0FBRSxLQUFLLFFBQVEsQ0FBQyxJQUFFO0FBQUEsVUFBQyxHQUFFLFFBQU0sR0FBRSxNQUFJLENBQUM7QUFBQSxTQUFHLEdBQUUsS0FBRSxDQUFDLEdBQUUsR0FBRSxJQUFJLElBQUUsR0FBRSxHQUFHO0FBQUE7QUFBQSxLQUFHLEdBQUUsTUFBRyxHQUFFLElBQUUsRUFBQztBQUFBLEtBQUcsR0FBRSxVQUFRLFFBQVEsQ0FBQyxJQUFFO0FBQUEsSUFBQyxNQUFHLEdBQUUsRUFBQztBQUFBLElBQUUsSUFBSSxJQUFFLEtBQUUsR0FBRTtBQUFBLElBQUksTUFBRyxHQUFFLFFBQU0sR0FBRSxJQUFJLEdBQUcsS0FBSyxRQUFRLENBQUMsSUFBRTtBQUFBLE1BQUMsSUFBRztBQUFBLFFBQUMsR0FBRSxFQUFDO0FBQUEsUUFBRSxPQUFNLElBQUU7QUFBQSxRQUFDLEtBQUU7QUFBQTtBQUFBLEtBQUcsR0FBRSxHQUFFLE1BQVMsV0FBRSxNQUFHLEdBQUUsSUFBSSxJQUFFLEdBQUUsR0FBRztBQUFBO0FBQUEsRUFBSSxJQUFJLEtBQWMsT0FBTyx5QkFBbkI7QUFBQSxFQUF5QyxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFJLElBQUUsS0FBRSxRQUFRLEdBQUU7QUFBQSxNQUFDLGFBQWEsRUFBQyxHQUFFLE1BQUcscUJBQXFCLEVBQUMsR0FBRSxXQUFXLEVBQUM7QUFBQSxPQUFHLEtBQUUsV0FBVyxJQUFFLEVBQUU7QUFBQSxJQUFFLE9BQUksS0FBRSxzQkFBc0IsRUFBQztBQUFBO0FBQUEsRUFBRyxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsSUFBRSxLQUFFLEdBQUU7QUFB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QUUsR0FBRSxHQUFFLEdBQU8sV0FBRSxHQUFFLElBQUUsR0FBTyxXQUFFLEdBQU8sV0FBRSxHQUFFLEdBQUM7QUFBQSxRQUFFLElBQVksR0FBRSxNQUFOO0FBQUEsVUFBUSxHQUFFLEVBQUUsSUFBRTtBQUFBLFFBQUUsR0FBRSxJQUFFO0FBQUEsUUFBRSxHQUFFLElBQUU7QUFBQSxRQUFFLElBQUcsS0FBRyxHQUFFO0FBQUEsVUFBRSxHQUFFLEVBQUUsRUFBQztBQUFBLFFBQUUsT0FBTztBQUFBLE1BQUMsRUFBTSxTQUFRLEdBQUUsTUFBUCxJQUFTO0FBQUEsUUFBQyxHQUFFLElBQUU7QUFBQSxRQUFFLElBQVksR0FBRSxNQUFOLFdBQVE7QUFBQSxVQUFDLEdBQUUsRUFBRSxJQUFFLEdBQUU7QUFBQSxVQUFFLElBQVksR0FBRSxNQUFOO0FBQUEsWUFBUSxHQUFFLEVBQUUsSUFBRSxHQUFFO0FBQUEsVUFBRSxHQUFFLElBQUUsR0FBRTtBQUFBLFVBQUUsR0FBRSxJQUFPO0FBQUEsVUFBRSxHQUFFLEVBQUUsSUFBRTtBQUFBLFVBQUUsR0FBRSxJQUFFO0FBQUEsUUFBQztBQUFBLFFBQUMsT0FBTztBQUFBLE1BQUM7QUFBQSxJQUFDO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUUsSUFBRTtBQUFBLElBQUMsS0FBSyxJQUFFO0FBQUEsSUFBRSxLQUFLLElBQUU7QUFBQSxJQUFFLEtBQUssSUFBTztBQUFBLElBQUUsS0FBSyxJQUFPO0FBQUEsSUFBRSxLQUFLLElBQUU7QUFBQSxJQUFFLEtBQUssSUFBUSxNQUFOLE9BQWEsWUFBRSxHQUFFO0FBQUEsSUFBUSxLQUFLLElBQVEsTUFBTixPQUFhLFlBQUUsR0FBRTtBQUFBLElBQVUsS0FBSyxPQUFXLE1BQU4sT0FBYSxZQUFFLEdBQUU7QUFBQTtBQUFBLEVBQUssR0FBRSxVQUFVLFFBQU07QUFBQSxFQUFFLEdBQUUsVUFBVSxJQUFFLFFBQVEsR0FBRTtBQUFBLElBQUMsT0FBTTtBQUFBO0FBQUEsRUFBSSxHQUFFLFVBQVUsSUFBRSxRQUFRLENB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LE1BQUUsS0FBSztBQUFBLE1BQUk7QUFBQSxNQUFJO0FBQUEsTUFBSSxJQUFHO0FBQUEsUUFBQyxTQUFRLEtBQUUsS0FBSyxFQUFXLE9BQUosV0FBTSxLQUFFLEdBQUU7QUFBQSxVQUFFLEdBQUUsRUFBRSxFQUFFO0FBQUEsZ0JBQUU7QUFBQSxRQUFRLEdBQUU7QUFBQTtBQUFBLElBQUU7QUFBQSxJQUFFLENBQUM7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUUsSUFBRTtBQUFBLElBQUMsT0FBTyxJQUFJLEdBQUUsSUFBRSxFQUFDO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLFNBQVEsS0FBRSxHQUFFLEVBQVcsT0FBSixXQUFNLEtBQUUsR0FBRTtBQUFBLE1BQUUsSUFBRyxHQUFFLEVBQUUsTUFBSSxHQUFFLEtBQUcsQ0FBQyxHQUFFLEVBQUUsRUFBRSxLQUFHLEdBQUUsRUFBRSxNQUFJLEdBQUU7QUFBQSxRQUFFLE9BQU07QUFBQSxJQUFHLE9BQU07QUFBQTtBQUFBLEVBQUcsU0FBUyxFQUFDLENBQUMsSUFBRTtBQUFBLElBQUMsU0FBUSxLQUFFLEdBQUUsRUFBVyxPQUFKLFdBQU0sS0FBRSxHQUFFLEdBQUU7QUFBQSxNQUFDLElBQUksS0FBRSxHQUFFLEVBQUU7QUFBQSxNQUFFLElBQVksT0FBSjtBQUFBLFFBQU0sR0FBRSxJQUFFO0FBQUEsTUFBRSxHQUFFLEVBQUUsSUFBRTtBQUFBLE1BQUUsR0FBRSxJQUFFO0FBQUEsTUFBRyxJQUFZLEdBQUUsTUFBTixXQUFRO0FBQUEsUUFBQyxHQUFFLElBQUU7QUFBQSxRQUFFO0FBQUEsTUFBSztBQUFBLElBQUM7QUFBQTtBQUFBLEVBQUUsU0FBUyxFQUFDLENBQUMsSUFBRTtBQUFBLElBQUMsSUFBSSxLQUFFLEdBQUUsR0FBRSxLQUFPO0FBQUEsSUFBRSxPQUFlLE9BQUosV0FBTTtBQUFBLE1BQUMsSUFBSSxLQUFFLEdBQUU7QUFBQSxNQUFFLElBQVEsR0FBRSxNQUFQLElBQVM7QUFBQSxRQUFDLEdBQUUsRUFBRSxFQUFFLEVBQUM7QUFBQSxRQUFFLElBQVksT0FBSjtBQUFBLFVBQU0sR0FBRSxJQUFFLEdBQUU7QUFBQSxRQUFFLElBQVksR0FBRSxNQUFOO0FBQUEsVUFBUSxHQUFFLEVBQUUsSUFBRTtBQUFBLE1BQUMsRUFBTTtBQUFBLGFBQUU7QUFBQSxNQUFFLEdBQUUsRUFBRSxJQUFFLEdBQUU7QUFBQSxNQUFFLElBQVksR0FBRSxNQUFOO0FBQUEsUUFBUSxHQUFFLElBQU87QUFBQSxNQUFFLEtBQUU7QUFBQSxJQUFDO0FBQUEsSUFBQyxHQUFFLElBQUU7QUFBQTtBQUFBLEVBQUUsU0FBUyxFQUFDLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxHQUFFLEtBQUssTUFBVSxTQUFDO0FBQUEsSUFBRSxLQUFLLElBQUU7QUFBQSxJQUFFLEtBQUssSUFBTztBQUFBLElBQUUsS0FBSyxJQUFFLEtBQUU7QUFBQSxJQUFFLEtBQUssSUFBRTtBQUFBLElBQUUsS0FBSyxJQUFRLE1BQU4sT0FBYSxZQUFFLEdBQUU7QUFBQSxJQUFRLEtBQUssSUFBUSxNQUFOLE9BQWEsWUFBRSxHQUFFO0FBQUEsSUFBVSxLQUFLLE9BQVcsTUFBTixPQUFhLFlBQUUsR0FBRTtBQUFBO0FBQUEsRUFBSyxHQUFFLFlBQVUsSUFBSTtBQUFBLEVBQUUsR0FBRSxVQUFVLElBQUUsUUFBUSxHQUFFO0FBQUEsSUFBQyxLQUFLLEtBQUc7QUFBQSxJQUFHLElBQUcsSUFBRSxLQUFLO0FBQUEsTUFBRSxPQUFNO0FBQUEsSUFBRyxLQUFRLEtBQUcsS0FBSyxNQUFiO0FBQUEsTUFBZ0IsT0FBTTtBQUFBLElBQUcsS0FBSyxLQUFHO0FBQUEsSUFBRyxJQUFHLEtBQUssTUFBSTtBQUFBLE1BQUUsT0FBTTtBQUFBLElBQUcsS0FBSyxJQUFFO0FBQUEsSUFBRSxLQUFLLEtBQUc7QUFBQSxJQUFFLElBQUcsS0FBSyxJQUFFLEtBQUcsQ0FBQyxHQUFFLElBQUksR0FBRTtBQUFBLE1BQUMsS0FBSyxLQUFHO0FBQUEsTUFBRyxPQUFNO0FBQUEsSUFBRTtBQUFBLElBQUMsSUFBSSxLQUFFO0FBQUEsSUFBRSxJQUFHO0FBQUEsTUFBQyxHQUFFLElBQUk7QUFBQSxNQUFFLEtBQUU7QUFBQSxNQUFLLElBQUksS0FBRSxLQUFLLEVBQUU7QUFBQSxNQUFFLElBQUcsS0FBRyxLQUFLLEtBQUcsS0FBSyxNQUFJLE1BQU8sS0FBSyxNQUFULEdBQVc7QUFBQSxRQUFDLEtBQUssSUFBRTtBQUFBLFFBQUUsS0FBSyxLQUFHO0FBQUEsUUFBSSxLQUFLO0FBQUEsTUFBRztBQUFBLE1BQUUsT0FBTSxJQUFFO0FBQUEsTUFBQyxLQUFLLElBQUU7QUFBQSxNQUFFLEtBQUssS0FBRztBQUFBLE1BQUcsS0FBSztBQUFBO0FBQUEsSUFBSSxLQUFFO0FBQUEsSUFBRSxHQUFFLElBQUk7QUFBQSxJQUFFLEtBQUssS0FBRztBQUFBLElBQUcsT0FBTTtBQUFBO0FBQUEsRUFBSSxHQUFFLFVBQVUsSUFBRSxRQUFRLENBQUMsSUFBRTtBQUFBLElBQUMsSUFBWSxLQUFLLE1BQVQsV0FBVztBQUFBLE1BQUMsS0FBSyxLQUFHO0FBQUEsTUFBRyxTQUFRLEtBQUUsS0FBSyxFQUFXLE9BQUosV0FBTSxLQUFFLEdBQUU7QUFBQSxRQUFFLEdBQUUsRUFBRSxFQUFFLEVBQUM7QUFBQSxJQUFDO0FBQUEsSUFBQyxHQUFFLFVBQVUsRUFBRSxLQUFLLE1BQUssRUFBQztBQUFBO0FBQUEsRUFBRyxHQUFFLFVBQVUsSUFBRSxRQUFRLENBQUMsSUFBRTtBQUFBLElBQUMsSUFBWSxLQUFLLE1BQVQsV0FBVztBQUFBLE1BQUMsR0FBRSxVQUFVLEVBQUUsS0FBSyxNQUFLLEVBQUM7QUFBQSxNQUFFLElBQVksS0FBSyxNQUFULFdBQVc7QUFBQSxRQUFDLEtBQUssS0FBRztBQUFBLFFBQUksU0FBUSxLQUFFLEtBQUssRUFBVyxPQUFKLFdBQU0sS0FBRSxHQUFFO0FBQUEsVUFBRSxHQUFFLEVBQUUsRUFBRSxFQUFDO0FBQUEsTUFBQztBQUFBLElBQUM7QUFBQTtBQUFBLEVBQUcsR0FBRSxVQUFVLElBQUUsUUFBUSxHQUFFO0FBQUEsSUFBQyxJQUFHLEVBQUUsSUFBRSxLQUFLLElBQUc7QUFBQSxNQUFDLEtBQUssS0FBRztBQUFBLE1BQUUsU0FBUSxLQUFFLEtBQUssRUFBVyxPQUFKLFdBQU0sS0FBRSxHQUFFO0FBQUEsUUFBRSxHQUFFLEVBQUUsRUFBRTtBQUFBLElBQUM7QUFBQTtBQUFBLEVBQUcsT0FBTyxlQUFlLEdBQUUsV0FBVSxTQUFRLEVBQUMsS0FBSSxRQUFRLEdBQUU7QUFBQSxJQUFDLElBQUcsSUFBRSxLQUFLO0FBQUEsTUFBRSxNQUFNLElBQUksTUFBTSxnQkFBZ0I7QUFBQSxJQUFFLElBQUksS0FBRSxHQUFFLElBQUk7QUFBQSxJQUFFLEtBQUssRUFBRTtBQUFBLElBQUUsSUFBWSxPQUFKO0FBQUEsTUFBTSxHQUFFLElBQUUsS0FBSztBQUFBLElBQUUsSUFBRyxLQUFHLEtBQUs7QUFBQSxNQUFFLE1BQU0sS0FBSztBQUFBLElBQUUsT0FBTyxLQUFLO0FBQUEsSUFBRSxDQUFDO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFLElBQUU7QUFBQSxJQUFDLE9BQU8sSUFBSSxHQUFFLElBQUUsRUFBQztBQUFBO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsR0FBRTtBQUFBLElBQUUsR0FBRSxJQUFPO0FBQUEsSUFBRSxJQUFlLE9BQU8sTUFBbkIsWUFBcUI7QUFBQSxNQUFDO0FBQUEsTUFBSSxJQUFJLEtBQUU7QUFBQSxNQUFFLEtBQU87QUFBQSxNQUFFLElBQUc7QUFBQSxRQUFDLEdBQUU7QUFBQSxRQUFFLE9BQU0sSUFBRTtBQUFBLFFBQUMsR0FBRSxLQUFHO0FBQUEsUUFBRyxHQUFFLEtBQUc7QUFBQSxRQUFFLEdBQUUsRUFBQztBQUFBLFFBQUUsTUFBTTtBQUFBLGdCQUFFO0FBQUEsUUFBUSxLQUFFO0FBQUEsUUFBRSxHQUFFO0FBQUE7QUFBQSxJQUFFO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLFNBQVEsS0FBRSxHQUFFLEVBQVcsT0FBSixXQUFNLEtBQUUsR0FBRTtBQUFBLE1BQUUsR0FBRSxFQUFFLEVBQUUsRUFBQztBQUFBLElBQUUsR0FBRSxJQUFPO0FBQUEsSUFBRSxHQUFFLElBQU87QUFBQSxJQUFFLEdBQUUsRUFBQztBQUFBO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFHLE9BQUk7QUFBQSxNQUFLLE1BQU0sSUFBSSxNQUFNLHFCQUFxQjtBQUFBLElBQUUsR0FBRSxJQUFJO0FBQUEsSUFBRSxLQUFFO0FBQUEsSUFBRSxLQUFLLEtBQUc7QUFBQSxJQUFHLElBQUcsSUFBRSxLQUFLO0FBQUEsTUFBRSxHQUFFLElBQUk7QUFBQSxJQUFFLEdBQUU7QUFBQTtBQUFBLEVBQUUsU0FBUyxFQUFDLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxLQUFLLElBQUU7QUFBQSxJQUFFLEtBQUssSUFBTztBQUFBLElBQUUsS0FBSyxJQUFPO0FBQUEsSUFBRSxLQUFLLElBQU87QUFBQSxJQUFFLEtBQUssSUFBRTtBQUFBLElBQUcsS0FBSyxPQUFXLE1BQU4sT0FBYSxZQUFFLEdBQUU7QUFBQSxJQUFLLElBQUc7QUFBQSxNQUFFLEdBQUUsS0FBSyxJQUFJO0FBQUE7QUFBQSxFQUFFLEdBQUUsVUFBVSxJQUFFLFFBQVEsR0FBRTtBQUFBLElBQUMsSUFBSSxLQUFFLEtBQUssRUFBRTtBQUFBLElBQUUsSUFBRztBQUFBLE1BQUMsSUFBRyxJQUFFLEtBQUs7QUFBQSxRQUFFO0FBQUEsTUFBTyxJQUFZLEtBQUssTUFBVDtBQUFBLFFBQVc7QUFBQSxNQUFPLElBQUksS0FBRSxLQUFLLEVBQUU7QUFBQSxNQUFFLElBQWUsT0FBTyxNQUFuQjtBQUFBLFFBQXFCLEtBQUssSUFBRTtBQUFBLGNBQUU7QUFBQSxNQUFRLEdBQUU7QUFBQTtBQUFBO0FBQUEsRUFBSSxHQUFFLFVBQVUsSUFBRSxRQUFRLEdBQUU7QUFBQSxJQUFDLElBQUcsSUFBRSxLQUFLO0FBQUEsTUFBRSxNQUFNLElBQUksTUFBTSxnQkFBZ0I7QUFBQSxJQUFFLEtBQUssS0FBRztBQUFBLElBQUUsS0FBSyxLQUFHO0FBQUEsSUFBRyxHQUFFLElBQUk7QUFBQSxJQUFFLEdBQUUsSUFBSTtBQUFBLElBQUU7QUFBQSxJQUFJLElBQUksS0FBRTtBQUFBLElBQUUsS0FBRTtBQUFBLElBQUssT0FBTyxHQUFFLEtBQUssTUFBSyxFQUFDO0FBQUE7QUFBQSxFQUFHLEdBQUUsVUFBVSxJQUFFLFFBQVEsR0FBRTtBQUFBLElBQUMsSUFBRyxFQUFFLElBQUUsS0FBSyxJQUFHO0FBQUEsTUFBQyxLQUFLLEtBQUc7QUFBQSxNQUFFLEtBQUssSUFBRTtBQUFBLE1BQUUsS0FBRTtBQUFBLElBQUk7QUFBQTtBQUFBLEVBQUcsR0FBRSxVQUFVLElBQUUsUUFBUSxHQUFFO0FBQUEsSUFBQyxLQUFLLEtBQUc7QUFBQSxJQUFFLElBQUcsRUFBRSxJQUFFLEtBQUs7QUFBQSxNQUFHLEdBQUUsSUFBSTtBQUFBO0FBQUEsRUFBRyxHQUFFLFVBQVUsVUFBUSxRQUFRLEdBQUU7QUFBQSxJQUFDLEtBQUssRUFBRTtBQUFBO0FBQUEsRUFBRyxTQUFTLEVBQUMsQ0FBQyxJQUFFLElBQUU7QUFBQSxJQUFDLElBQUksS0FBRSxJQUFJLEdBQUUsSUFBRSxFQUFDO0FBQUEsSUFBRSxJQUFHO0FBQUEsTUFBQyxHQUFFLEVBQUU7QUFBQSxNQUFFLE9BQU0sSUFBRTtBQUFBLE1BQUMsR0FBRSxFQUFFO0FBQUEsTUFBRSxNQUFNO0FBQUE7QUFBQSxJQUFFLElBQUksS0FBRSxHQUFFLEVBQUUsS0FBSyxFQUFDO0FBQUEsSUFBRSxHQUFFLE9BQU8sV0FBUztBQUFBLElBQUUsT0FBTztBQUFBO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxPQUFPLFFBQVEsR0FBRTtBQUFBLE1BQUMsSUFBSSxLQUFFLFdBQVUsS0FBRTtBQUFBLE1BQUssT0FBTyxHQUFFLFFBQVEsR0FBRTtBQUFBLFFBQUMsT0FBTyxHQUFFLFFBQVEsR0FBRTtBQUFBLFVBQUMsT0FBTyxHQUFFLE1BQU0sSUFBRSxDQUFDLEVBQUUsTUFBTSxLQUFLLEVBQUMsQ0FBQztBQUFBLFNBQUU7QUFBQSxPQUFFO0FBQUE7QUFBQTtBQUFBLEVBQUcsU0FBUyxFQUFDLEdBQUU7QUFBQSxJQUFDLElBQUksS0FBRTtBQUFBLElBQUUsS0FBRSxDQUFDO0FBQUEsSUFBRSxPQUFPLFFBQVEsR0FBRTtBQUFBLE1BQUMsSUFBSSxLQUFFO0FBQUEsTUFBRSxJQUFHLE1BQUc7QUFBQSxRQUFFLEtBQUUsR0FBRSxPQUFPLEVBQUM7QUFBQSxNQUFFLEtBQUU7QUFBQSxNQUFFLE9BQU87QUFBQTtBQUFBO0FBQUEsRUFBRyxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxPQUFPLFFBQVEsR0FBRTtBQUFBLE1BQUMsSUFBSSxJQUFFLElBQUUsS0FBRSxHQUFFO0FBQUEsTUFBRSxJQUFHO0FBQUEsUUFBQyxLQUFFLEdBQUUsTUFBVyxXQUFFLENBQUMsRUFBRSxNQUFNLEtBQUssU0FBUyxDQUFDO0FBQUEsUUFBRSxPQUFNLElBQUU7QUFBQSxRQUFDLEtBQU87QUFBQSxRQUFFLE1BQU07QUFBQSxnQkFBRTtBQUFBLFFBQVEsS0FBRSxHQUFFO0FBQUE7QUFBQSxNQUFFLFNBQVEsTUFBSztBQUFBLFFBQUUsSUFBZSxPQUFPLEdBQUUsT0FBckI7QUFBQSxVQUF3QixHQUFFLE1BQUcsR0FBRSxHQUFFLEdBQUU7QUFBQSxNQUFFLEdBQUUsT0FBTyxXQUFTLEdBQUUsUUFBUSxHQUFFO0FBQUEsUUFBQyxJQUFHO0FBQUEsVUFBRSxTQUFRLEtBQUUsRUFBRSxLQUFFLEdBQUUsUUFBTztBQUFBLFlBQUksR0FBRSxJQUFHLFFBQVE7QUFBQSxRQUFFLEtBQU87QUFBQSxPQUFFO0FBQUEsTUFBRSxPQUFPO0FBQUE7QUFBQTs7O0VEQXoxSixJQUFJO0FBQUEsRUFBSixJQUFNO0FBQUEsRUFBTixJQUFRO0FBQUEsRUFBUixJQUFVLEtBQWUsT0FBTyxVQUFwQixlQUE0QixDQUFDLENBQUMsT0FBTztBQUFBLEVBQWpELElBQTZFLEtBQUUsQ0FBQztBQUFBLEVBQWhGLElBQWtGLEtBQUUsQ0FBQztBQUFBLEVBQUUsR0FBRSxRQUFRLEdBQUU7QUFBQSxJQUFDLEtBQUUsS0FBSztBQUFBLEdBQUUsRUFBRTtBQUFBLEVBQUUsU0FBUyxFQUFDLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxFQUFFLE1BQUcsR0FBRSxLQUFLLE1BQUssRUFBRSxPQUFJLFFBQVEsR0FBRSxFQUFFO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLElBQUcsSUFBRTtBQUFBLE1BQUMsSUFBSSxLQUFFO0FBQUEsTUFBRSxLQUFPO0FBQUEsTUFBRSxHQUFFO0FBQUEsSUFBQztBQUFBLElBQUMsS0FBRSxNQUFHLEdBQUUsRUFBRTtBQUFBO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsTUFBSyxLQUFFLEdBQUUsTUFBSyxLQUFFLFVBQVUsRUFBQztBQUFBLElBQUUsR0FBRSxRQUFNO0FBQUEsSUFBRSxJQUFJLEtBQUUsR0FBRSxRQUFRLEdBQUU7QUFBQSxNQUFDLElBQUksS0FBRSxJQUFFLEtBQUUsR0FBRTtBQUFBLE1BQUksT0FBTSxLQUFFLEdBQUU7QUFBQSxRQUFHLElBQUcsR0FBRSxLQUFJO0FBQUEsVUFBQyxHQUFFLElBQUksUUFBTTtBQUFBLFVBQUU7QUFBQSxRQUFLO0FBQUEsTUFBQyxJQUFJLEtBQUUsR0FBRSxRQUFRLEdBQUU7QUFBQSxRQUFDLElBQUksS0FBRSxHQUFFLE1BQU07QUFBQSxRQUFNLE9BQVcsT0FBSixJQUFNLElBQU8sT0FBTCxPQUFPLEtBQUcsTUFBRztBQUFBLE9BQUcsR0FBRSxLQUFFLEdBQUUsUUFBUSxHQUFFO0FBQUEsUUFBQyxPQUFNLENBQUMsTUFBTSxRQUFRLEdBQUUsS0FBSyxLQUFHLENBQUMsRUFBRSxHQUFFLEtBQUs7QUFBQSxPQUFFLEdBQUUsS0FBRSxHQUFFLFFBQVEsR0FBRTtBQUFBLFFBQUMsS0FBSyxJQUFFO0FBQUEsUUFBRSxJQUFHLEdBQUUsT0FBTTtBQUFBLFVBQUMsSUFBSSxLQUFFLEdBQUU7QUFBQSxVQUFNLElBQUcsR0FBRSxPQUFLLEdBQUUsSUFBSSxPQUFTLEdBQUUsSUFBSSxJQUFJLGFBQWQ7QUFBQSxZQUF1QixHQUFFLElBQUksSUFBSSxPQUFLO0FBQUEsUUFBQztBQUFBLE9BQUUsR0FBRSxLQUFFLEdBQUUsS0FBSztBQUFBLE1BQUUsR0FBRSxLQUFLLElBQUUsUUFBUSxHQUFFO0FBQUEsUUFBQyxHQUFFO0FBQUEsUUFBRSxHQUFFLEtBQUssSUFBSTtBQUFBO0FBQUEsTUFBRyxPQUFNLENBQUMsSUFBRSxFQUFDO0FBQUEsT0FBRyxDQUFDLENBQUMsR0FBRSxLQUFFLEdBQUUsSUFBRyxLQUFFLEdBQUU7QUFBQSxJQUFHLE9BQU8sR0FBRSxRQUFNLEdBQUUsS0FBSyxJQUFFLEdBQUU7QUFBQTtBQUFBLEVBQU0sR0FBRSxjQUFZO0FBQUEsRUFBbUIsT0FBTyxpQkFBaUIsR0FBRSxXQUFVLEVBQUMsYUFBWSxFQUFDLGNBQWEsTUFBRyxPQUFXLFVBQUMsR0FBRSxNQUFLLEVBQUMsY0FBYSxNQUFHLE9BQU0sR0FBQyxHQUFFLE9BQU0sRUFBQyxjQUFhLE1BQUcsS0FBSSxRQUFRLEdBQUU7QUFBQSxJQUFDLElBQUksS0FBRTtBQUFBLElBQUssT0FBTSxFQUFDLE1BQUssTUFBSyxLQUFLLEdBQUU7QUFBQSxNQUFDLE9BQU8sR0FBRTtBQUFBLE1BQU0sRUFBQztBQUFBLElBQUUsR0FBRSxLQUFJLEVBQUMsY0FBYSxNQUFHLE9BQU0sRUFBQyxFQUFDLENBQUM7QUFBQSxFQUFFLEdBQUUsT0FBTSxRQUFRLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxJQUFhLE9BQU8sR0FBRSxRQUFuQixVQUF3QjtBQUFBLE1BQUMsSUFBSSxJQUFFLEtBQUUsR0FBRTtBQUFBLE1BQU0sU0FBUSxNQUFLO0FBQUEsUUFBRSxJQUFnQixPQUFiLFlBQWU7QUFBQSxVQUFDLElBQUksS0FBRSxHQUFFO0FBQUEsVUFBRyxJQUFHLGNBQWEsSUFBRTtBQUFBLFlBQUMsSUFBRyxDQUFDO0FBQUEsY0FBRSxHQUFFLE9BQUssS0FBRSxDQUFDO0FBQUEsWUFBRSxHQUFFLE1BQUc7QUFBQSxZQUFFLEdBQUUsTUFBRyxHQUFFLEtBQUs7QUFBQSxVQUFDO0FBQUEsUUFBQztBQUFBLElBQUM7QUFBQSxJQUFDLEdBQUUsRUFBQztBQUFBLEdBQUU7QUFBQSxFQUFFLEdBQUUsT0FBTSxRQUFRLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxHQUFFLEVBQUM7QUFBQSxJQUFFLElBQUcsR0FBRSxTQUFPLEdBQUU7QUFBQSxNQUFDLEdBQUU7QUFBQSxNQUFFLElBQUksSUFBRSxLQUFFLEdBQUU7QUFBQSxNQUFJLElBQUcsSUFBRTtBQUFBLFFBQUMsR0FBRSxRQUFNO0FBQUEsUUFBRyxLQUFhLEtBQUUsR0FBRSxVQUFUO0FBQUEsVUFBZSxHQUFFLE9BQUssS0FBRSxRQUFRLENBQUMsSUFBRSxJQUFFO0FBQUEsWUFBQyxJQUFJO0FBQUEsWUFBRSxHQUFFLFFBQVEsR0FBRTtBQUFBLGNBQUMsS0FBRTtBQUFBLGVBQU0sRUFBQyxNQUFLLEdBQUMsQ0FBQztBQUFBLFlBQUUsR0FBRSxJQUFFO0FBQUEsWUFBRSxPQUFPO0FBQUEsWUFBRyxRQUFRLEdBQUU7QUFBQSxZQUFDLElBQUk7QUFBQSxZQUFFLElBQUc7QUFBQSxlQUFTLEtBQUUsR0FBRSxNQUFYLFFBQWUsR0FBRSxLQUFLLEVBQUM7QUFBQSxZQUFFLEdBQUUsUUFBTTtBQUFBLFlBQUUsR0FBRSxTQUFTLENBQUMsQ0FBQztBQUFBLGFBQWUsT0FBTyxHQUFFLFFBQXJCLGFBQTBCLEdBQUUsS0FBSyxlQUFhLEdBQUUsS0FBSyxPQUFLLEVBQUU7QUFBQSxNQUFDO0FBQUEsTUFBQyxLQUFFO0FBQUEsTUFBRSxHQUFFLEVBQUM7QUFBQSxJQUFDO0FBQUEsR0FBRTtBQUFBLEVBQUUsR0FBRSxPQUFNLFFBQVEsQ0FBQyxJQUFFLElBQUUsSUFBRSxJQUFFO0FBQUEsSUFBQyxHQUFFO0FBQUEsSUFBRSxLQUFPO0FBQUEsSUFBRSxHQUFFLElBQUUsSUFBRSxFQUFDO0FBQUEsR0FBRTtBQUFB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QUFFLElBQUUsSUFBRSxJQUFFO0FBQUEsSUFBQyxJQUFHLEtBQUUsS0FBTyxPQUFKO0FBQUEsTUFBTSxHQUFFLFFBQU07QUFBQSxJQUFFLEdBQUUsSUFBRSxJQUFFLEVBQUM7QUFBQSxHQUFFO0FBQUEsRUFBRSxFQUFFLFVBQVUsd0JBQXNCLFFBQVEsQ0FBQyxJQUFFLElBQUU7QUFBQSxJQUFDLElBQUcsS0FBSztBQUFBLE1BQUksT0FBTTtBQUFBLElBQUcsSUFBSSxLQUFFLEtBQUssTUFBSyxLQUFFLE1BQVksR0FBRSxNQUFOO0FBQUEsSUFBUSxTQUFRLE1BQUs7QUFBQSxNQUFFLE9BQU07QUFBQSxJQUFHLElBQUcsS0FBSyxPQUFnQixPQUFPLEtBQUssS0FBdkIsYUFBK0IsS0FBSyxNQUFWLE1BQVk7QUFBQSxNQUFDLElBQUksS0FBRSxJQUFFLEtBQUs7QUFBQSxNQUFLLElBQUcsRUFBRSxNQUFHLE1BQUcsSUFBRSxLQUFLO0FBQUEsUUFBTSxPQUFNO0FBQUEsTUFBRyxJQUFHLElBQUUsS0FBSztBQUFBLFFBQUssT0FBTTtBQUFBLElBQUUsRUFBSztBQUFBLE1BQUMsSUFBRyxFQUFFLE1BQUcsSUFBRSxLQUFLO0FBQUEsUUFBTSxPQUFNO0FBQUEsTUFBRyxJQUFHLElBQUUsS0FBSztBQUFBLFFBQUssT0FBTTtBQUFBO0FBQUEsSUFBRyxTQUFRLE1BQUs7QUFBQSxNQUFFLElBQWdCLE9BQWIsY0FBZ0IsR0FBRSxRQUFLLEtBQUssTUFBTTtBQUFBLFFBQUcsT0FBTTtBQUFBLElBQUcsU0FBUSxNQUFLLEtBQUs7QUFBQSxNQUFNLElBQUcsRUFBRSxNQUFLO0FBQUEsUUFBRyxPQUFNO0FBQUEsSUFBRyxPQUFNO0FBQUE7QUFBQSxFQUFJLFNBQVMsU0FBUyxDQUFDLElBQUUsSUFBRTtBQUFBLElBQUMsT0FBTyxHQUFFLFFBQVEsR0FBRTtBQUFBLE1BQUMsT0FBTyxHQUFFLElBQUUsRUFBQztBQUFBLE9BQUcsQ0FBQyxDQUFDO0FBQUE7QUFBQSxFQUFFLFNBQVMsV0FBVyxDQUFDLElBQUUsSUFBRTtBQUFB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LFVBS0U7QUFBQSw0QkFKQSxHQUFDLGFBQUQscUNBQWE7QUFBQSw0QkFDYixHQUFDLG9CQUFELHFDQUFvQjtBQUFBLDRCQUNwQixHQUFDLGtCQUFELHFDQUFrQjtBQUFBLDRCQUNsQixHQUFDLHlCQUFELHFDQUF5QjtBQUFBO0FBQUEsV0FKM0IsZ0NBS0U7QUFBQSx3QkFDRixHQUFzQyxNQUF0QztBQUFBO0FBQUEsNENBQXNDO0FBQUEsd0JBQ3RDLEdBS0UsT0FMRjtBQUFBLFVBQUssT0FBTTtBQUFBLFVBQVgsVUFLRTtBQUFBLDRCQUpBLEdBQUMsYUFBRCxxQ0FBYTtBQUFBLDRCQUNiLEdBQUMsbUJBQUQscUNBQW1CO0FBQUEsNEJBQ25CLEdBQUMsWUFBRCxxQ0FBWTtBQUFBLDRCQUNaLEdBQUMsb0JBQUQscUNBQW9CO0FBQUE7QUFBQSxXQUp0QixnQ0FLRTtBQUFBLHdCQUNGLEdBQWlCLE1BQWpCO0FBQUE7QUFBQSw0Q0FBaUI7QUFBQSx3QkFDakIsR0FBQyxrQkFBRCxxQ0FBa0I7QUFBQTtBQUFBLE9BL0JwQixnQ0FnQ0U7QUFBQTtBQUFBLEVBSU4sSUFBTSxPQUFPLFNBQVMsZUFBZSxLQUFLO0FBQUEsRUFDMUMsSUFBSSxDQUFDO0FBQUEsSUFBTSxNQUFNLElBQUksTUFBTSxxQkFBcUI7QUFBQSxFQUNoRCxrQkFBTyxHQUFDLGdCQUFELHFDQUFnQixHQUFJLElBQUk7IiwKICAiZGVidWdJZCI6ICJFMkU2OTAyNEFCNjI1MzNCNjQ3NTZFMjE2NDc1NkUyMSIsCiAgIm5hbWVzIjogW10KfQ==
