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

  // src/signals-test.tsx
  init_preact_module();

  // node_modules/preact/hooks/dist/hooks.module.js
  init_preact_module();
  var t2;
  var r2;
  var u2;
  var i2;
  var o2 = 0;
  var f2 = [];
  var c2 = l;
  var e2 = c2.__b;
  var a2 = c2.__r;
  var v2 = c2.diffed;
  var l2 = c2.__c;
  var m2 = c2.unmount;
  var s2 = c2.__;
  function p2(n2, t3) {
    c2.__h && c2.__h(r2, n2, o2 || t3), o2 = 0;
    var u3 = r2.__H || (r2.__H = { __: [], __h: [] });
    return n2 >= u3.__.length && u3.__.push({}), u3.__[n2];
  }
  function d2(n2) {
    return o2 = 1, h2(D2, n2);
  }
  function h2(n2, u3, i3) {
    var o3 = p2(t2++, 2);
    if (o3.t = n2, !o3.__c && (o3.__ = [i3 ? i3(u3) : D2(undefined, u3), function(n3) {
      var t3 = o3.__N ? o3.__N[0] : o3.__[0], r3 = o3.t(t3, n3);
      t3 !== r3 && (o3.__N = [r3, o3.__[1]], o3.__c.setState({}));
    }], o3.__c = r2, !r2.__f)) {
      var f3 = function(n3, t3, r3) {
        if (!o3.__c.__H)
          return true;
        var u4 = o3.__c.__H.__.filter(function(n4) {
          return n4.__c;
        });
        if (u4.every(function(n4) {
          return !n4.__N;
        }))
          return !c3 || c3.call(this, n3, t3, r3);
        var i4 = o3.__c.props !== n3;
        return u4.some(function(n4) {
          if (n4.__N) {
            var t4 = n4.__[0];
            n4.__ = n4.__N, n4.__N = undefined, t4 !== n4.__[0] && (i4 = true);
          }
        }), c3 && c3.call(this, n3, t3, r3) || i4;
      };
      r2.__f = true;
      var { shouldComponentUpdate: c3, componentWillUpdate: e3 } = r2;
      r2.componentWillUpdate = function(n3, t3, r3) {
        if (this.__e) {
          var u4 = c3;
          c3 = undefined, f3(n3, t3, r3), c3 = u4;
        }
        e3 && e3.call(this, n3, t3, r3);
      }, r2.shouldComponentUpdate = f3;
    }
    return o3.__N || o3.__;
  }
  function y2(n2, u3) {
    var i3 = p2(t2++, 3);
    !c2.__s && C2(i3.__H, u3) && (i3.__ = n2, i3.u = u3, r2.__H.__h.push(i3));
  }
  function A2(n2) {
    return o2 = 5, T2(function() {
      return { current: n2 };
    }, []);
  }
  function T2(n2, r3) {
    var u3 = p2(t2++, 7);
    return C2(u3.__H, r3) && (u3.__ = n2(), u3.__H = r3, u3.__h = n2), u3.__;
  }
  function j2() {
    for (var n2;n2 = f2.shift(); ) {
      var t3 = n2.__H;
      if (n2.__P && t3)
        try {
          t3.__h.some(z2), t3.__h.some(B2), t3.__h = [];
        } catch (r3) {
          t3.__h = [], c2.__e(r3, n2.__v);
        }
    }
  }
  c2.__b = function(n2) {
    r2 = null, e2 && e2(n2);
  }, c2.__ = function(n2, t3) {
    n2 && t3.__k && t3.__k.__m && (n2.__m = t3.__k.__m), s2 && s2(n2, t3);
  }, c2.__r = function(n2) {
    a2 && a2(n2), t2 = 0;
    var i3 = (r2 = n2.__c).__H;
    i3 && (u2 === r2 ? (i3.__h = [], r2.__h = [], i3.__.some(function(n3) {
      n3.__N && (n3.__ = n3.__N), n3.u = n3.__N = undefined;
    })) : (i3.__h.some(z2), i3.__h.some(B2), i3.__h = [], t2 = 0)), u2 = r2;
  }, c2.diffed = function(n2) {
    v2 && v2(n2);
    var t3 = n2.__c;
    t3 && t3.__H && (t3.__H.__h.length && (f2.push(t3) !== 1 && i2 === c2.requestAnimationFrame || ((i2 = c2.requestAnimationFrame) || w2)(j2)), t3.__H.__.some(function(n3) {
      n3.u && (n3.__H = n3.u), n3.u = undefined;
    })), u2 = r2 = null;
  }, c2.__c = function(n2, t3) {
    t3.some(function(n3) {
      try {
        n3.__h.some(z2), n3.__h = n3.__h.filter(function(n4) {
          return !n4.__ || B2(n4);
        });
      } catch (r3) {
        t3.some(function(n4) {
          n4.__h && (n4.__h = []);
        }), t3 = [], c2.__e(r3, n3.__v);
      }
    }), l2 && l2(n2, t3);
  }, c2.unmount = function(n2) {
    m2 && m2(n2);
    var t3, r3 = n2.__c;
    r3 && r3.__H && (r3.__H.__.some(function(n3) {
      try {
        z2(n3);
      } catch (n4) {
        t3 = n4;
      }
    }), r3.__H = undefined, t3 && c2.__e(t3, r3.__v));
  };
  var k2 = typeof requestAnimationFrame == "function";
  function w2(n2) {
    var t3, r3 = function() {
      clearTimeout(u3), k2 && cancelAnimationFrame(t3), setTimeout(n2);
    }, u3 = setTimeout(r3, 35);
    k2 && (t3 = requestAnimationFrame(r3));
  }
  function z2(n2) {
    var t3 = r2, u3 = n2.__c;
    typeof u3 == "function" && (n2.__c = undefined, u3()), r2 = t3;
  }
  function B2(n2) {
    var t3 = r2;
    n2.__c = n2.__(), r2 = t3;
  }
  function C2(n2, t3) {
    return !n2 || n2.length !== t3.length || t3.some(function(t4, r3) {
      return t4 !== n2[r3];
    });
  }
  function D2(n2, t3) {
    return typeof t3 == "function" ? t3(n2) : t3;
  }

  // node_modules/@preact/signals/dist/signals.module.js
  init_preact_module();

  // node_modules/@preact/signals-core/dist/signals-core.module.js
  var i3 = Symbol.for("preact-signals");
  function t3() {
    if (!(s3 > 1)) {
      var i4, t4 = false;
      (function() {
        var i5 = d3;
        d3 = undefined;
        while (i5 !== undefined) {
          if (i5.S.v === i5.v)
            i5.S.i = i5.i;
          i5 = i5.o;
        }
      })();
      while (h3 !== undefined) {
        var n2 = h3;
        h3 = undefined;
        v3++;
        while (n2 !== undefined) {
          var r3 = n2.u;
          n2.u = undefined;
          n2.f &= -3;
          if (!(8 & n2.f) && w3(n2))
            try {
              n2.c();
            } catch (n3) {
              if (!t4) {
                i4 = n3;
                t4 = true;
              }
            }
          n2 = r3;
        }
      }
      v3 = 0;
      s3--;
      if (t4)
        throw i4;
    } else
      s3--;
  }
  function n2(i4) {
    if (s3 > 0)
      return i4();
    e3 = ++u3;
    s3++;
    try {
      return i4();
    } finally {
      t3();
    }
  }
  var r3 = undefined;
  function o3(i4) {
    var t4 = r3;
    r3 = undefined;
    try {
      return i4();
    } finally {
      r3 = t4;
    }
  }
  var f3;
  var h3 = undefined;
  var s3 = 0;
  var v3 = 0;
  var u3 = 0;
  var e3 = 0;
  var d3 = undefined;
  var c3 = 0;
  function a3(i4) {
    if (r3 !== undefined) {
      var t4 = i4.n;
      if (t4 === undefined || t4.t !== r3) {
        t4 = { i: 0, S: i4, p: r3.s, n: undefined, t: r3, e: undefined, x: undefined, r: t4 };
        if (r3.s !== undefined)
          r3.s.n = t4;
        r3.s = t4;
        i4.n = t4;
        if (32 & r3.f)
          i4.S(t4);
        return t4;
      } else if (t4.i === -1) {
        t4.i = 0;
        if (t4.n !== undefined) {
          t4.n.p = t4.p;
          if (t4.p !== undefined)
            t4.p.n = t4.n;
          t4.p = r3.s;
          t4.n = undefined;
          r3.s.n = t4;
          r3.s = t4;
        }
        return t4;
      }
    }
  }
  function l3(i4, t4) {
    this.v = i4;
    this.i = 0;
    this.n = undefined;
    this.t = undefined;
    this.l = 0;
    this.W = t4 == null ? undefined : t4.watched;
    this.Z = t4 == null ? undefined : t4.unwatched;
    this.name = t4 == null ? undefined : t4.name;
  }
  l3.prototype.brand = i3;
  l3.prototype.h = function() {
    return true;
  };
  l3.prototype.S = function(i4) {
    var t4 = this, n3 = this.t;
    if (n3 !== i4 && i4.e === undefined) {
      i4.x = n3;
      this.t = i4;
      if (n3 !== undefined)
        n3.e = i4;
      else
        o3(function() {
          var i5;
          (i5 = t4.W) == null || i5.call(t4);
        });
    }
  };
  l3.prototype.U = function(i4) {
    var t4 = this;
    if (this.t !== undefined) {
      var { e: n3, x: r4 } = i4;
      if (n3 !== undefined) {
        n3.x = r4;
        i4.e = undefined;
      }
      if (r4 !== undefined) {
        r4.e = n3;
        i4.x = undefined;
      }
      if (i4 === this.t) {
        this.t = r4;
        if (r4 === undefined)
          o3(function() {
            var i5;
            (i5 = t4.Z) == null || i5.call(t4);
          });
      }
    }
  };
  l3.prototype.subscribe = function(i4) {
    var t4 = this;
    return C3(function() {
      var n3 = t4.value, o4 = r3;
      r3 = undefined;
      try {
        i4(n3);
      } finally {
        r3 = o4;
      }
    }, { name: "sub" });
  };
  l3.prototype.valueOf = function() {
    return this.value;
  };
  l3.prototype.toString = function() {
    return this.value + "";
  };
  l3.prototype.toJSON = function() {
    return this.value;
  };
  l3.prototype.peek = function() {
    var i4 = r3;
    r3 = undefined;
    try {
      return this.value;
    } finally {
      r3 = i4;
    }
  };
  Object.defineProperty(l3.prototype, "value", { get: function() {
    var i4 = a3(this);
    if (i4 !== undefined)
      i4.i = this.i;
    return this.v;
  }, set: function(i4) {
    if (i4 !== this.v) {
      if (v3 > 100)
        throw new Error("Cycle detected");
      (function(i5) {
        if (s3 !== 0 && v3 === 0) {
          if (i5.l !== e3) {
            i5.l = e3;
            d3 = { S: i5, v: i5.v, i: i5.i, o: d3 };
          }
        }
      })(this);
      this.v = i4;
      this.i++;
      c3++;
      s3++;
      try {
        for (var n3 = this.t;n3 !== undefined; n3 = n3.x)
          n3.t.N();
      } finally {
        t3();
      }
    }
  } });
  function y3(i4, t4) {
    return new l3(i4, t4);
  }
  function w3(i4) {
    for (var t4 = i4.s;t4 !== undefined; t4 = t4.n)
      if (t4.S.i !== t4.i || !t4.S.h() || t4.S.i !== t4.i)
        return true;
    return false;
  }
  function _2(i4) {
    for (var t4 = i4.s;t4 !== undefined; t4 = t4.n) {
      var n3 = t4.S.n;
      if (n3 !== undefined)
        t4.r = n3;
      t4.S.n = t4;
      t4.i = -1;
      if (t4.n === undefined) {
        i4.s = t4;
        break;
      }
    }
  }
  function b2(i4) {
    var t4 = i4.s, n3 = undefined;
    while (t4 !== undefined) {
      var r4 = t4.p;
      if (t4.i === -1) {
        t4.S.U(t4);
        if (r4 !== undefined)
          r4.n = t4.n;
        if (t4.n !== undefined)
          t4.n.p = r4;
      } else
        n3 = t4;
      t4.S.n = t4.r;
      if (t4.r !== undefined)
        t4.r = undefined;
      t4 = r4;
    }
    i4.s = n3;
  }
  function p3(i4, t4) {
    l3.call(this, undefined);
    this.x = i4;
    this.s = undefined;
    this.g = c3 - 1;
    this.f = 4;
    this.W = t4 == null ? undefined : t4.watched;
    this.Z = t4 == null ? undefined : t4.unwatched;
    this.name = t4 == null ? undefined : t4.name;
  }
  p3.prototype = new l3;
  p3.prototype.h = function() {
    this.f &= -3;
    if (1 & this.f)
      return false;
    if ((36 & this.f) == 32)
      return true;
    this.f &= -5;
    if (this.g === c3)
      return true;
    this.g = c3;
    this.f |= 1;
    if (this.i > 0 && !w3(this)) {
      this.f &= -2;
      return true;
    }
    var i4 = r3;
    try {
      _2(this);
      r3 = this;
      var t4 = this.x();
      if (16 & this.f || this.v !== t4 || this.i === 0) {
        this.v = t4;
        this.f &= -17;
        this.i++;
      }
    } catch (i5) {
      this.v = i5;
      this.f |= 16;
      this.i++;
    }
    r3 = i4;
    b2(this);
    this.f &= -2;
    return true;
  };
  p3.prototype.S = function(i4) {
    if (this.t === undefined) {
      this.f |= 36;
      for (var t4 = this.s;t4 !== undefined; t4 = t4.n)
        t4.S.S(t4);
    }
    l3.prototype.S.call(this, i4);
  };
  p3.prototype.U = function(i4) {
    if (this.t !== undefined) {
      l3.prototype.U.call(this, i4);
      if (this.t === undefined) {
        this.f &= -33;
        for (var t4 = this.s;t4 !== undefined; t4 = t4.n)
          t4.S.U(t4);
      }
    }
  };
  p3.prototype.N = function() {
    if (!(2 & this.f)) {
      this.f |= 6;
      for (var i4 = this.t;i4 !== undefined; i4 = i4.x)
        i4.t.N();
    }
  };
  Object.defineProperty(p3.prototype, "value", { get: function() {
    if (1 & this.f)
      throw new Error("Cycle detected");
    var i4 = a3(this);
    this.h();
    if (i4 !== undefined)
      i4.i = this.i;
    if (16 & this.f)
      throw this.v;
    return this.v;
  } });
  function g2(i4, t4) {
    return new p3(i4, t4);
  }
  function S2(i4) {
    var n3 = i4.m;
    i4.m = undefined;
    if (typeof n3 == "function") {
      s3++;
      var o4 = r3;
      r3 = undefined;
      try {
        n3();
      } catch (t4) {
        i4.f &= -2;
        i4.f |= 8;
        m3(i4);
        throw t4;
      } finally {
        r3 = o4;
        t3();
      }
    }
  }
  function m3(i4) {
    for (var t4 = i4.s;t4 !== undefined; t4 = t4.n)
      t4.S.U(t4);
    i4.x = undefined;
    i4.s = undefined;
    S2(i4);
  }
  function x2(i4) {
    if (r3 !== this)
      throw new Error("Out-of-order effect");
    b2(this);
    r3 = i4;
    this.f &= -2;
    if (8 & this.f)
      m3(this);
    t3();
  }
  function E2(i4, t4) {
    this.x = i4;
    this.m = undefined;
    this.s = undefined;
    this.u = undefined;
    this.f = 32;
    this.name = t4 == null ? undefined : t4.name;
    if (f3)
      f3.push(this);
  }
  E2.prototype.c = function() {
    var i4 = this.S();
    try {
      if (8 & this.f)
        return;
      if (this.x === undefined)
        return;
      var t4 = this.x();
      if (typeof t4 == "function")
        this.m = t4;
    } finally {
      i4();
    }
  };
  E2.prototype.S = function() {
    if (1 & this.f)
      throw new Error("Cycle detected");
    this.f |= 1;
    this.f &= -9;
    S2(this);
    _2(this);
    s3++;
    var i4 = r3;
    r3 = this;
    return x2.bind(this, i4);
  };
  E2.prototype.N = function() {
    if (!(2 & this.f)) {
      this.f |= 2;
      this.u = h3;
      h3 = this;
    }
  };
  E2.prototype.d = function() {
    this.f |= 8;
    if (!(1 & this.f))
      m3(this);
  };
  E2.prototype.dispose = function() {
    this.d();
  };
  function C3(i4, t4) {
    var n3 = new E2(i4, t4);
    try {
      n3.c();
    } catch (i5) {
      n3.d();
      throw i5;
    }
    var r4 = n3.d.bind(n3);
    r4[Symbol.dispose] = r4;
    return r4;
  }
  function O2(i4) {
    return function() {
      var t4 = arguments, r4 = this;
      return n2(function() {
        return o3(function() {
          return i4.apply(r4, [].slice.call(t4));
        });
      });
    };
  }
  function j3() {
    var i4 = f3;
    f3 = [];
    return function() {
      var t4 = f3;
      if (f3 && i4)
        i4 = i4.concat(f3);
      f3 = i4;
      return t4;
    };
  }
  function k3(i4) {
    return function() {
      var t4, n3, r4 = j3();
      try {
        n3 = i4.apply(undefined, [].slice.call(arguments));
      } catch (i5) {
        f3 = undefined;
        throw i5;
      } finally {
        t4 = r4();
      }
      for (var o4 in n3)
        if (typeof n3[o4] == "function")
          n3[o4] = O2(n3[o4]);
      n3[Symbol.dispose] = O2(function() {
        if (t4)
          for (var i5 = 0;i5 < t4.length; i5++)
            t4[i5].dispose();
        t4 = undefined;
      });
      return n3;
    };
  }

  // node_modules/@preact/signals/dist/signals.module.js
  var l4;
  var d4;
  var h4;
  var p4 = typeof window != "undefined" && !!window.__PREACT_SIGNALS_DEVTOOLS__;
  var m4 = [];
  var _3 = [];
  C3(function() {
    l4 = this.N;
  })();
  function g3(i4, r4) {
    l[i4] = r4.bind(null, l[i4] || function() {});
  }
  function b3(i4) {
    if (h4) {
      var n3 = h4;
      h4 = undefined;
      n3();
    }
    h4 = i4 && i4.S();
  }
  function y4(i4) {
    var n3 = this, t4 = i4.data, e4 = useSignal(t4);
    e4.value = t4;
    var f4 = T2(function() {
      var i5 = n3, t5 = n3.__v;
      while (t5 = t5.__)
        if (t5.__c) {
          t5.__c.__$f |= 4;
          break;
        }
      var o4 = g2(function() {
        var i6 = e4.value.value;
        return i6 === 0 ? 0 : i6 === true ? "" : i6 || "";
      }), f5 = g2(function() {
        return !Array.isArray(o4.value) && !t(o4.value);
      }), a5 = C3(function() {
        this.N = F2;
        if (f5.value) {
          var n4 = o4.value;
          if (i5.__v && i5.__v.__e && i5.__v.__e.nodeType === 3)
            i5.__v.__e.data = n4;
        }
      }), v5 = n3.__$u.d;
      n3.__$u.d = function() {
        a5();
        v5.call(this);
      };
      return [f5, o4];
    }, []), a4 = f4[0], v4 = f4[1];
    return a4.value ? v4.peek() : v4.value;
  }
  y4.displayName = "ReactiveTextNode";
  Object.defineProperties(l3.prototype, { constructor: { configurable: true, value: undefined }, type: { configurable: true, value: y4 }, props: { configurable: true, get: function() {
    var i4 = this;
    return { data: { get value() {
      return i4.value;
    } } };
  } }, __b: { configurable: true, value: 1 } });
  g3("__b", function(i4, n3) {
    if (typeof n3.type == "string") {
      var r4, t4 = n3.props;
      for (var o4 in t4)
        if (o4 !== "children") {
          var e4 = t4[o4];
          if (e4 instanceof l3) {
            if (!r4)
              n3.__np = r4 = {};
            r4[o4] = e4;
            t4[o4] = e4.peek();
          }
        }
    }
    i4(n3);
  });
  g3("__r", function(i4, n3) {
    i4(n3);
    if (n3.type !== k) {
      b3();
      var r4, o4 = n3.__c;
      if (o4) {
        o4.__$f &= -2;
        if ((r4 = o4.__$u) === undefined)
          o4.__$u = r4 = function(i5, n4) {
            var r5;
            C3(function() {
              r5 = this;
            }, { name: n4 });
            r5.c = i5;
            return r5;
          }(function() {
            var i5;
            if (p4)
              (i5 = r4.y) == null || i5.call(r4);
            o4.__$f |= 1;
            o4.setState({});
          }, typeof n3.type == "function" ? n3.type.displayName || n3.type.name : "");
      }
      d4 = o4;
      b3(r4);
    }
  });
  g3("__e", function(i4, n3, r4, t4) {
    b3();
    d4 = undefined;
    i4(n3, r4, t4);
  });
  g3("diffed", function(i4, n3) {
    b3();
    d4 = undefined;
    var r4;
    if (typeof n3.type == "string" && (r4 = n3.__e)) {
      var { __np: t4, props: o4 } = n3;
      if (t4) {
        var e4 = r4.U;
        if (e4)
          for (var f4 in e4) {
            var u4 = e4[f4];
            if (u4 !== undefined && !(f4 in t4)) {
              u4.d();
              e4[f4] = undefined;
            }
          }
        else {
          e4 = {};
          r4.U = e4;
        }
        for (var a4 in t4) {
          var c4 = e4[a4], v4 = t4[a4];
          if (c4 === undefined) {
            c4 = w4(r4, a4, v4);
            e4[a4] = c4;
          } else
            c4.o(v4, o4);
        }
        for (var s4 in t4)
          o4[s4] = t4[s4];
      }
    }
    i4(n3);
  });
  function w4(i4, n3, r4, t4) {
    var o4 = n3 in i4 && i4.ownerSVGElement === undefined, e4 = y3(r4), f4 = r4.peek();
    return { o: function(i5, n4) {
      e4.value = i5;
      f4 = i5.peek();
    }, d: C3(function() {
      this.N = F2;
      var r5 = e4.value.value;
      if (f4 !== r5) {
        f4 = undefined;
        if (o4)
          i4[n3] = r5;
        else if (r5 != null && (r5 !== false || n3[4] === "-"))
          i4.setAttribute(n3, r5);
        else
          i4.removeAttribute(n3);
      } else
        f4 = undefined;
    }) };
  }
  g3("unmount", function(i4, n3) {
    if (typeof n3.type == "string") {
      var r4 = n3.__e;
      if (r4) {
        var t4 = r4.U;
        if (t4) {
          r4.U = undefined;
          for (var o4 in t4) {
            var e4 = t4[o4];
            if (e4)
              e4.d();
          }
        }
      }
      n3.__np = undefined;
    } else {
      var f4 = n3.__c;
      if (f4) {
        var u4 = f4.__$u;
        if (u4) {
          f4.__$u = undefined;
          u4.d();
        }
      }
    }
    i4(n3);
  });
  g3("__h", function(i4, n3, r4, t4) {
    if (t4 < 3 || t4 === 9)
      n3.__$f |= 2;
    i4(n3, r4, t4);
  });
  x.prototype.shouldComponentUpdate = function(i4, n3) {
    if (this.__R)
      return true;
    var r4 = this.__$u, t4 = r4 && r4.s !== undefined;
    for (var o4 in n3)
      return true;
    if (this.__f || typeof this.u == "boolean" && this.u === true) {
      var e4 = 2 & this.__$f;
      if (!(t4 || e4 || 4 & this.__$f))
        return true;
      if (1 & this.__$f)
        return true;
    } else {
      if (!(t4 || 4 & this.__$f))
        return true;
      if (3 & this.__$f)
        return true;
    }
    for (var f4 in i4)
      if (f4 !== "__source" && i4[f4] !== this.props[f4])
        return true;
    for (var u4 in this.props)
      if (!(u4 in i4))
        return true;
    return false;
  };
  function useSignal(i4, n3) {
    return T2(function() {
      return y3(i4, n3);
    }, []);
  }
  function useComputed(i4, n3) {
    var r4 = A2(i4);
    r4.current = i4;
    d4.__$f |= 4;
    return T2(function() {
      return g2(function() {
        return r4.current();
      }, n3);
    }, []);
  }
  var k4 = typeof requestAnimationFrame == "undefined" ? setTimeout : function(i4) {
    var n3 = function() {
      clearTimeout(r4);
      cancelAnimationFrame(t4);
      i4();
    }, r4 = setTimeout(n3, 35), t4 = requestAnimationFrame(n3);
  };
  var q2 = function(i4) {
    queueMicrotask(function() {
      queueMicrotask(i4);
    });
  };
  function A3() {
    n2(function() {
      var i4;
      while (i4 = m4.shift())
        l4.call(i4);
    });
  }
  function T3() {
    if (m4.push(this) === 1)
      (l.requestAnimationFrame || k4)(A3);
  }
  function x3() {
    n2(function() {
      var i4;
      while (i4 = _3.shift())
        l4.call(i4);
    });
  }
  function F2() {
    if (_3.push(this) === 1)
      (l.requestAnimationFrame || q2)(x3);
  }
  function useSignalEffect(i4, n3) {
    var r4 = A2(i4);
    r4.current = i4;
    y2(function() {
      return C3(function() {
        this.N = T3;
        return r4.current();
      }, n3);
    }, []);
  }
  function M2(i4) {
    var n3 = T2(function() {
      return i4();
    }, []);
    y2(function() {
      return n3[Symbol.dispose];
    }, [n3]);
    return n3;
  }

  // node_modules/@preact/signals/utils/dist/utils.module.js
  init_preact_module();
  var i4 = function(n3) {
    return typeof n3.children == "function" ? n3.children(n3.v, n3.i) : n3.children;
  };
  i4.displayName = "Item";
  function o4(n3) {
    var t4 = typeof n3.when == "function" ? n3.when() : n3.when.value;
    if (!t4)
      return n3.fallback || null;
    else
      return _(i4, { v: t4, children: n3.children });
  }
  o4.displayName = "Show";
  function u4(o5) {
    var u5 = T2(function() {
      return new Map;
    }, []), f4 = typeof o5.each == "function" ? o5.each() : o5.each, c4 = f4 instanceof l3 ? f4.value : f4;
    if (!c4.length)
      return o5.fallback || null;
    var a4 = new Set(u5.keys()), p5 = c4.map(function(n3, t4) {
      a4.delete(n3);
      if (!u5.has(n3)) {
        var e4 = _(i4, { v: n3, i: t4, children: o5.children });
        u5.set(n3, e4);
        return e4;
      }
      return u5.get(n3);
    });
    a4.forEach(function(n3) {
      u5.delete(n3);
    });
    return _(k, null, p5);
  }
  u4.displayName = "For";

  // node_modules/preact/jsx-runtime/dist/jsxRuntime.module.js
  init_preact_module();
  init_preact_module();
  var f4 = 0;
  function u5(e4, t4, n3, o5, i5, u6) {
    t4 || (t4 = {});
    var a4, c4, p5 = t4;
    if ("ref" in p5)
      for (c4 in p5 = {}, t4)
        c4 == "ref" ? a4 = t4[c4] : p5[c4] = t4[c4];
    var l5 = { type: e4, props: p5, key: n3, ref: a4, __k: null, __: null, __b: 0, __e: null, __c: null, constructor: undefined, __v: --f4, __i: -1, __u: 0, __source: i5, __self: u6 };
    if (typeof e4 == "function" && (a4 = e4.defaultProps))
      for (c4 in a4)
        p5[c4] === undefined && (p5[c4] = a4[c4]);
    return l.vnode && l.vnode(l5), l5;
  }

  // src/signals-test.tsx
  var results = y3([]);
  var autoCount = y3(0);
  var t1Renders = 0;
  function Test1_AutoSubscribe() {
    t1Renders++;
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 1: Auto-subscribe"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "signal.value in JSX: ",
            /* @__PURE__ */ u5("strong", {
              children: autoCount.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "dim",
          children: [
            "Component renders: ",
            t1Renders
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            autoCount.value++;
          },
          children: "Increment"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "If the number updates when you click, auto-subscribe works with Bun's bundler."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var bridgeSignal = y3(0);
  function Test2_Bridge() {
    const [local, setLocal] = d2(bridgeSignal.value);
    useSignalEffect(() => {
      setLocal(bridgeSignal.value);
    });
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 2: useSignalEffect bridge"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "Signal: ",
            /* @__PURE__ */ u5("strong", {
              id: "t2-signal",
              children: bridgeSignal.value
            }, undefined, false, undefined, this),
            " | Local state: ",
            /* @__PURE__ */ u5("strong", {
              id: "t2-local",
              children: local
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            bridgeSignal.value++;
          },
          children: "Increment signal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: 'Both numbers should update together. If only "Signal" updates, auto-subscribe works but bridge is redundant. If neither updates, both are broken.'
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var CounterModel = k3(() => {
    const count = y3(0);
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
    const m5 = M2(CounterModel);
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 3: createModel + useModel"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "Count: ",
            /* @__PURE__ */ u5("strong", {
              children: m5.count.value
            }, undefined, false, undefined, this),
            " | Doubled:",
            " ",
            /* @__PURE__ */ u5("strong", {
              children: m5.doubled.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: m5.increment,
          children: "+1"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: m5.reset,
          children: "Reset"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "Tests model creation, computed derivation, and action batching."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var modalEvent = y3(null);
  function Test4_Modal() {
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 4: Modal (conditional render from signal)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            modalEvent.value = { id: 1, name: "Cat detected!" };
          },
          children: "Open Modal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            modalEvent.value = null;
          },
          children: "Close Modal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "modalEvent: ",
            /* @__PURE__ */ u5("code", {
              children: JSON.stringify(modalEvent.value)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        modalEvent.value && /* @__PURE__ */ u5("div", {
          class: "mock-modal",
          children: /* @__PURE__ */ u5("div", {
            class: "mock-modal-content",
            children: [
              /* @__PURE__ */ u5("strong", {
                children: "Modal Open!"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u5("p", {
                children: [
                  "Event: ",
                  modalEvent.value.name,
                  " (id=",
                  modalEvent.value.id,
                  ")"
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ u5("button", {
                onClick: () => {
                  modalEvent.value = null;
                },
                children: "×"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: `If the modal does NOT appear when clicking "Open Modal", auto-subscribe is broken and the component doesn't re-render on signal change.`
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test4b_ModalBridge() {
    const [ev, setEv] = d2(modalEvent.value);
    useSignalEffect(() => {
      setEv(modalEvent.value);
    });
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 4b: Modal (bridge workaround)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            modalEvent.value = { id: 2, name: "Dog detected!" };
          },
          children: "Open Modal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            modalEvent.value = null;
          },
          children: "Close"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "local ev: ",
            /* @__PURE__ */ u5("code", {
              children: JSON.stringify(ev)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        ev && /* @__PURE__ */ u5("div", {
          class: "mock-modal",
          children: /* @__PURE__ */ u5("div", {
            class: "mock-modal-content",
            children: [
              /* @__PURE__ */ u5("strong", {
                children: "Bridge Modal Open!"
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u5("p", {
                children: [
                  "Event: ",
                  ev.name,
                  " (id=",
                  ev.id,
                  ")"
                ]
              }, undefined, true, undefined, this),
              /* @__PURE__ */ u5("button", {
                onClick: () => {
                  modalEvent.value = null;
                },
                children: "×"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "Same modal but using useSignalEffect→useState bridge."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var ModalStore = k3(() => {
    const selected = y3(null);
    const items = y3([
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
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 5: useModel + modal (production pattern)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("div", {
          class: "item-list",
          children: store.items.value.map((item) => /* @__PURE__ */ u5("button", {
            onClick: () => store.openModal(item),
            children: item.name
          }, item.id, false, undefined, this))
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "selected: ",
            /* @__PURE__ */ u5("code", {
              children: JSON.stringify(store.selected.value)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        store.selected.value && /* @__PURE__ */ u5("div", {
          class: "mock-modal",
          children: /* @__PURE__ */ u5("div", {
            class: "mock-modal-content",
            children: [
              /* @__PURE__ */ u5("strong", {
                children: store.selected.value.name
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u5("button", {
                onClick: store.closeModal,
                children: "×"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "This is the exact pattern from app.tsx. If the modal doesn't appear, createModel + auto-subscribe is the problem."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test5b_StoreModalBridge() {
    const store = M2(ModalStore);
    const [sel, setSel] = d2(store.selected.value);
    useSignalEffect(() => {
      setSel(store.selected.value);
    });
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 5b: useModel + bridge modal"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("div", {
          class: "item-list",
          children: store.items.value.map((item) => /* @__PURE__ */ u5("button", {
            onClick: () => store.openModal(item),
            children: item.name
          }, item.id, false, undefined, this))
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "local sel: ",
            /* @__PURE__ */ u5("code", {
              children: JSON.stringify(sel)
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        sel && /* @__PURE__ */ u5("div", {
          class: "mock-modal",
          children: /* @__PURE__ */ u5("div", {
            class: "mock-modal-content",
            children: [
              /* @__PURE__ */ u5("strong", {
                children: sel.name
              }, undefined, false, undefined, this),
              /* @__PURE__ */ u5("button", {
                onClick: store.closeModal,
                children: "×"
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "Same but with useSignalEffect bridge."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test6_UseSignal() {
    const count = useSignal(0);
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 6: useSignal (component-local)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "Count: ",
            /* @__PURE__ */ u5("strong", {
              children: count.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            count.value++;
          },
          children: "+1"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "useSignal creates a component-scoped signal."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function Test7_UseComputed() {
    const count = useSignal(0);
    const label = useComputed(() => count.value === 0 ? "zero" : count.value < 5 ? "few" : "many");
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 7: useComputed"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "Count: ",
            /* @__PURE__ */ u5("strong", {
              children: count.value
            }, undefined, false, undefined, this),
            " | Label: ",
            /* @__PURE__ */ u5("strong", {
              children: label.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            count.value++;
          },
          children: "+1"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            count.value = 0;
          },
          children: "Reset"
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var batchA = y3(0);
  var batchB = y3(0);
  function Test8_Batch() {
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 8: batch()"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "A: ",
            /* @__PURE__ */ u5("strong", {
              children: batchA.value
            }, undefined, false, undefined, this),
            " | B: ",
            /* @__PURE__ */ u5("strong", {
              children: batchB.value
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            n2(() => {
              batchA.value++;
              batchB.value += 10;
            });
          },
          children: "Batch update (A+1, B+10)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
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
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 9: Diagnostics"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("pre", {
          children: JSON.stringify(info, null, 2)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          children: [
            "Side-effect import present:",
            " ",
            /* @__PURE__ */ u5("strong", {
              children: typeof y3 === "function" ? "YES" : "NO"
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "If preactOptions shows __b, __r, diffed, unmount — hooks are installed."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var showSignal = y3(null);
  function Test10_Show() {
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: [
            "Test 10: ",
            "<Show>",
            " component"
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            showSignal.value = "Hello from Show!";
          },
          children: "Show content"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            showSignal.value = null;
          },
          children: "Hide"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5(o4, {
          when: showSignal,
          children: (val) => /* @__PURE__ */ u5("div", {
            class: "mock-modal",
            children: /* @__PURE__ */ u5("div", {
              class: "mock-modal-content",
              children: /* @__PURE__ */ u5("strong", {
                children: val
              }, undefined, false, undefined, this)
            }, undefined, false, undefined, this)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: [
            "<Show when={signal}>",
            " renders children only when signal is truthy. No parent re-render needed."
          ]
        }, undefined, true, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var showModalEvent = y3(null);
  function Test10b_ShowModal() {
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: [
            "Test 10b: ",
            "<Show>",
            " modal pattern"
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("div", {
          class: "item-list",
          children: [
            /* @__PURE__ */ u5("button", {
              onClick: () => {
                showModalEvent.value = { id: 1, name: "Chatora" };
              },
              children: "Chatora"
            }, undefined, false, undefined, this),
            /* @__PURE__ */ u5("button", {
              onClick: () => {
                showModalEvent.value = { id: 2, name: "Mike" };
              },
              children: "Mike"
            }, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5(o4, {
          when: showModalEvent,
          children: (ev) => /* @__PURE__ */ u5("div", {
            class: "mock-modal",
            children: /* @__PURE__ */ u5("div", {
              class: "mock-modal-content",
              children: [
                /* @__PURE__ */ u5("strong", {
                  children: ev.name
                }, undefined, false, undefined, this),
                " (id=",
                ev.id,
                ")",
                /* @__PURE__ */ u5("button", {
                  onClick: () => {
                    showModalEvent.value = null;
                  },
                  children: "×"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "This is the ideal modal pattern — no useState, no bridge, no parent re-render."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var listItems = y3([
    { id: 1, name: "Chatora" },
    { id: 2, name: "Mike" },
    { id: 3, name: "Kijitora" }
  ]);
  function Test11_For() {
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: [
            "Test 11: ",
            "<For>",
            " component"
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5(u4, {
          each: listItems,
          children: (item) => /* @__PURE__ */ u5("div", {
            style: "padding: 4px 0;",
            children: [
              "#",
              item.id,
              " — ",
              /* @__PURE__ */ u5("strong", {
                children: item.name
              }, undefined, false, undefined, this)
            ]
          }, undefined, true, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            listItems.value = [
              ...listItems.value,
              { id: listItems.value.length + 1, name: `Pet #${listItems.value.length + 1}` }
            ];
          },
          children: "Add item"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("button", {
          onClick: () => {
            listItems.value = listItems.value.slice(0, -1);
          },
          children: "Remove last"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
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
    const selected = y3(null);
    const items = y3([
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
    return /* @__PURE__ */ u5("div", {
      class: "test-card",
      children: [
        /* @__PURE__ */ u5("h3", {
          children: "Test 12: useModel + Show + For (target pattern)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5(u4, {
          each: store.items,
          children: (item) => /* @__PURE__ */ u5("button", {
            onClick: () => store.openModal(item),
            children: item.name
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5(o4, {
          when: store.selected,
          children: (ev) => /* @__PURE__ */ u5("div", {
            class: "mock-modal",
            children: /* @__PURE__ */ u5("div", {
              class: "mock-modal-content",
              children: [
                /* @__PURE__ */ u5("strong", {
                  children: ev.name
                }, undefined, false, undefined, this),
                /* @__PURE__ */ u5("button", {
                  onClick: store.closeModal,
                  children: "×"
                }, undefined, false, undefined, this)
              ]
            }, undefined, true, undefined, this)
          }, undefined, false, undefined, this)
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "hint",
          children: "The ideal production pattern: createModel + useModel + Show + For. No useState, no useSignalEffect bridge, no parent re-renders."
        }, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  function SignalsTestApp() {
    return /* @__PURE__ */ u5("div", {
      class: "test-app",
      children: [
        /* @__PURE__ */ u5("h1", {
          children: "@preact/signals Test Bench"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("p", {
          class: "subtitle",
          children: [
            "Verify signal reactivity patterns before production use.",
            /* @__PURE__ */ u5("br", {}, undefined, false, undefined, this),
            "Build: Bun ",
            typeof Bun !== "undefined" ? "runtime" : "bundled",
            " | @preact/signals 2.8.2"
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("div", {
          class: "test-grid",
          children: [
            /* @__PURE__ */ u5(Test1_AutoSubscribe, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test2_Bridge, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test3_Model, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test6_UseSignal, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test7_UseComputed, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test8_Batch, {}, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("h2", {
          children: "Modal Tests (the broken case)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("div", {
          class: "test-grid",
          children: [
            /* @__PURE__ */ u5(Test4_Modal, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test4b_ModalBridge, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test5_StoreModal, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test5b_StoreModalBridge, {}, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("h2", {
          children: "Show / For (declarative pattern)"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5("div", {
          class: "test-grid",
          children: [
            /* @__PURE__ */ u5(Test10_Show, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test10b_ShowModal, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test11_For, {}, undefined, false, undefined, this),
            /* @__PURE__ */ u5(Test12_FullPattern, {}, undefined, false, undefined, this)
          ]
        }, undefined, true, undefined, this),
        /* @__PURE__ */ u5("h2", {
          children: "Diagnostics"
        }, undefined, false, undefined, this),
        /* @__PURE__ */ u5(Test9_Diagnostic, {}, undefined, false, undefined, this)
      ]
    }, undefined, true, undefined, this);
  }
  var root = document.getElementById("app");
  if (!root)
    throw new Error("#app root not found");
  J(/* @__PURE__ */ u5(SignalsTestApp, {}, undefined, false, undefined, this), root);
})();

//# debugId=DECBA892A12EDAB864756E2164756E21
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vbm9kZV9tb2R1bGVzL3ByZWFjdC9kaXN0L3ByZWFjdC5tb2R1bGUuanMiLCAiLi4vc3JjL3NpZ25hbHMtdGVzdC50c3giLCAiLi4vbm9kZV9tb2R1bGVzL3ByZWFjdC9ob29rcy9kaXN0L2hvb2tzLm1vZHVsZS5qcyIsICIuLi9ub2RlX21vZHVsZXMvQHByZWFjdC9zaWduYWxzL2Rpc3Qvc2lnbmFscy5tb2R1bGUuanMiLCAiLi4vbm9kZV9tb2R1bGVzL0BwcmVhY3Qvc2lnbmFscy1jb3JlL2Rpc3Qvc2lnbmFscy1jb3JlLm1vZHVsZS5qcyIsICIuLi9ub2RlX21vZHVsZXMvQHByZWFjdC9zaWduYWxzL3V0aWxzL2Rpc3QvdXRpbHMubW9kdWxlLmpzIiwgIi4uL25vZGVfbW9kdWxlcy9wcmVhY3QvanN4LXJ1bnRpbWUvZGlzdC9qc3hSdW50aW1lLm1vZHVsZS5qcyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsKICAgICJ2YXIgbixsLHUsdCxpLHIsbyxlLGYsYyxzLGEsaCxwPXt9LHY9W10seT0vYWNpdHxleCg/OnN8Z3xufHB8JCl8cnBofGdyaWR8b3dzfG1uY3xudHd8aW5lW2NoXXx6b298Xm9yZHxpdGVyYS9pLGQ9QXJyYXkuaXNBcnJheTtmdW5jdGlvbiB3KG4sbCl7Zm9yKHZhciB1IGluIGwpblt1XT1sW3VdO3JldHVybiBufWZ1bmN0aW9uIGcobil7biYmbi5wYXJlbnROb2RlJiZuLnBhcmVudE5vZGUucmVtb3ZlQ2hpbGQobil9ZnVuY3Rpb24gXyhsLHUsdCl7dmFyIGkscixvLGU9e307Zm9yKG8gaW4gdSlcImtleVwiPT1vP2k9dVtvXTpcInJlZlwiPT1vP3I9dVtvXTplW29dPXVbb107aWYoYXJndW1lbnRzLmxlbmd0aD4yJiYoZS5jaGlsZHJlbj1hcmd1bWVudHMubGVuZ3RoPjM/bi5jYWxsKGFyZ3VtZW50cywyKTp0KSxcImZ1bmN0aW9uXCI9PXR5cGVvZiBsJiZudWxsIT1sLmRlZmF1bHRQcm9wcylmb3IobyBpbiBsLmRlZmF1bHRQcm9wcyl2b2lkIDA9PT1lW29dJiYoZVtvXT1sLmRlZmF1bHRQcm9wc1tvXSk7cmV0dXJuIG0obCxlLGkscixudWxsKX1mdW5jdGlvbiBtKG4sdCxpLHIsbyl7dmFyIGU9e3R5cGU6bixwcm9wczp0LGtleTppLHJlZjpyLF9fazpudWxsLF9fOm51bGwsX19iOjAsX19lOm51bGwsX19jOm51bGwsY29uc3RydWN0b3I6dm9pZCAwLF9fdjpudWxsPT1vPysrdTpvLF9faTotMSxfX3U6MH07cmV0dXJuIG51bGw9PW8mJm51bGwhPWwudm5vZGUmJmwudm5vZGUoZSksZX1mdW5jdGlvbiBiKCl7cmV0dXJue2N1cnJlbnQ6bnVsbH19ZnVuY3Rpb24gayhuKXtyZXR1cm4gbi5jaGlsZHJlbn1mdW5jdGlvbiB4KG4sbCl7dGhpcy5wcm9wcz1uLHRoaXMuY29udGV4dD1sfWZ1bmN0aW9uIFMobixsKXtpZihudWxsPT1sKXJldHVybiBuLl9fP1Mobi5fXyxuLl9faSsxKTpudWxsO2Zvcih2YXIgdTtsPG4uX19rLmxlbmd0aDtsKyspaWYobnVsbCE9KHU9bi5fX2tbbF0pJiZudWxsIT11Ll9fZSlyZXR1cm4gdS5fX2U7cmV0dXJuXCJmdW5jdGlvblwiPT10eXBlb2Ygbi50eXBlP1Mobik6bnVsbH1mdW5jdGlvbiBDKG4pe2lmKG4uX19QJiZuLl9fZCl7dmFyIHU9bi5fX3YsdD11Ll9fZSxpPVtdLHI9W10sbz13KHt9LHUpO28uX192PXUuX192KzEsbC52bm9kZSYmbC52bm9kZShvKSx6KG4uX19QLG8sdSxuLl9fbixuLl9fUC5uYW1lc3BhY2VVUkksMzImdS5fX3U/W3RdOm51bGwsaSxudWxsPT10P1ModSk6dCwhISgzMiZ1Ll9fdSksciksby5fX3Y9dS5fX3Ysby5fXy5fX2tbby5fX2ldPW8sVihpLG8sciksdS5fX2U9dS5fXz1udWxsLG8uX19lIT10JiZNKG8pfX1mdW5jdGlvbiBNKG4pe2lmKG51bGwhPShuPW4uX18pJiZudWxsIT1uLl9fYylyZXR1cm4gbi5fX2U9bi5fX2MuYmFzZT1udWxsLG4uX19rLnNvbWUoZnVuY3Rpb24obCl7aWYobnVsbCE9bCYmbnVsbCE9bC5fX2UpcmV0dXJuIG4uX19lPW4uX19jLmJhc2U9bC5fX2V9KSxNKG4pfWZ1bmN0aW9uICQobil7KCFuLl9fZCYmKG4uX19kPSEwKSYmaS5wdXNoKG4pJiYhSS5fX3IrK3x8ciE9bC5kZWJvdW5jZVJlbmRlcmluZykmJigocj1sLmRlYm91bmNlUmVuZGVyaW5nKXx8bykoSSl9ZnVuY3Rpb24gSSgpe3RyeXtmb3IodmFyIG4sbD0xO2kubGVuZ3RoOylpLmxlbmd0aD5sJiZpLnNvcnQoZSksbj1pLnNoaWZ0KCksbD1pLmxlbmd0aCxDKG4pfWZpbmFsbHl7aS5sZW5ndGg9SS5fX3I9MH19ZnVuY3Rpb24gUChuLGwsdSx0LGkscixvLGUsZixjLHMpe3ZhciBhLGgseSxkLHcsZyxfLG09dCYmdC5fX2t8fHYsYj1sLmxlbmd0aDtmb3IoZj1BKHUsbCxtLGYsYiksYT0wO2E8YjthKyspbnVsbCE9KHk9dS5fX2tbYV0pJiYoaD0tMSE9eS5fX2kmJm1beS5fX2ldfHxwLHkuX19pPWEsZz16KG4seSxoLGkscixvLGUsZixjLHMpLGQ9eS5fX2UseS5yZWYmJmgucmVmIT15LnJlZiYmKGgucmVmJiZEKGgucmVmLG51bGwseSkscy5wdXNoKHkucmVmLHkuX19jfHxkLHkpKSxudWxsPT13JiZudWxsIT1kJiYodz1kKSwoXz0hISg0JnkuX191KSl8fGguX19rPT09eS5fX2s/Zj1IKHksZixuLF8pOlwiZnVuY3Rpb25cIj09dHlwZW9mIHkudHlwZSYmdm9pZCAwIT09Zz9mPWc6ZCYmKGY9ZC5uZXh0U2libGluZykseS5fX3UmPS03KTtyZXR1cm4gdS5fX2U9dyxmfWZ1bmN0aW9uIEEobixsLHUsdCxpKXt2YXIgcixvLGUsZixjLHM9dS5sZW5ndGgsYT1zLGg9MDtmb3Iobi5fX2s9bmV3IEFycmF5KGkpLHI9MDtyPGk7cisrKW51bGwhPShvPWxbcl0pJiZcImJvb2xlYW5cIiE9dHlwZW9mIG8mJlwiZnVuY3Rpb25cIiE9dHlwZW9mIG8/KFwic3RyaW5nXCI9PXR5cGVvZiBvfHxcIm51bWJlclwiPT10eXBlb2Ygb3x8XCJiaWdpbnRcIj09dHlwZW9mIG98fG8uY29uc3RydWN0b3I9PVN0cmluZz9vPW4uX19rW3JdPW0obnVsbCxvLG51bGwsbnVsbCxudWxsKTpkKG8pP289bi5fX2tbcl09bShrLHtjaGlsZHJlbjpvfSxudWxsLG51bGwsbnVsbCk6dm9pZCAwPT09by5jb25zdHJ1Y3RvciYmby5fX2I+MD9vPW4uX19rW3JdPW0oby50eXBlLG8ucHJvcHMsby5rZXksby5yZWY/by5yZWY6bnVsbCxvLl9fdik6bi5fX2tbcl09byxmPXIraCxvLl9fPW4sby5fX2I9bi5fX2IrMSxlPW51bGwsLTEhPShjPW8uX19pPVQobyx1LGYsYSkpJiYoYS0tLChlPXVbY10pJiYoZS5fX3V8PTIpKSxudWxsPT1lfHxudWxsPT1lLl9fdj8oLTE9PWMmJihpPnM/aC0tOmk8cyYmaCsrKSxcImZ1bmN0aW9uXCIhPXR5cGVvZiBvLnR5cGUmJihvLl9fdXw9NCkpOmMhPWYmJihjPT1mLTE/aC0tOmM9PWYrMT9oKys6KGM+Zj9oLS06aCsrLG8uX191fD00KSkpOm4uX19rW3JdPW51bGw7aWYoYSlmb3Iocj0wO3I8cztyKyspbnVsbCE9KGU9dVtyXSkmJjA9PSgyJmUuX191KSYmKGUuX19lPT10JiYodD1TKGUpKSxFKGUsZSkpO3JldHVybiB0fWZ1bmN0aW9uIEgobixsLHUsdCl7dmFyIGkscjtpZihcImZ1bmN0aW9uXCI9PXR5cGVvZiBuLnR5cGUpe2ZvcihpPW4uX19rLHI9MDtpJiZyPGkubGVuZ3RoO3IrKylpW3JdJiYoaVtyXS5fXz1uLGw9SChpW3JdLGwsdSx0KSk7cmV0dXJuIGx9bi5fX2UhPWwmJih0JiYobCYmbi50eXBlJiYhbC5wYXJlbnROb2RlJiYobD1TKG4pKSx1Lmluc2VydEJlZm9yZShuLl9fZSxsfHxudWxsKSksbD1uLl9fZSk7ZG97bD1sJiZsLm5leHRTaWJsaW5nfXdoaWxlKG51bGwhPWwmJjg9PWwubm9kZVR5cGUpO3JldHVybiBsfWZ1bmN0aW9uIEwobixsKXtyZXR1cm4gbD1sfHxbXSxudWxsPT1ufHxcImJvb2xlYW5cIj09dHlwZW9mIG58fChkKG4pP24uc29tZShmdW5jdGlvbihuKXtMKG4sbCl9KTpsLnB1c2gobikpLGx9ZnVuY3Rpb24gVChuLGwsdSx0KXt2YXIgaSxyLG8sZT1uLmtleSxmPW4udHlwZSxjPWxbdV0scz1udWxsIT1jJiYwPT0oMiZjLl9fdSk7aWYobnVsbD09PWMmJm51bGw9PWV8fHMmJmU9PWMua2V5JiZmPT1jLnR5cGUpcmV0dXJuIHU7aWYodD4ocz8xOjApKWZvcihpPXUtMSxyPXUrMTtpPj0wfHxyPGwubGVuZ3RoOylpZihudWxsIT0oYz1sW289aT49MD9pLS06cisrXSkmJjA9PSgyJmMuX191KSYmZT09Yy5rZXkmJmY9PWMudHlwZSlyZXR1cm4gbztyZXR1cm4tMX1mdW5jdGlvbiBqKG4sbCx1KXtcIi1cIj09bFswXT9uLnNldFByb3BlcnR5KGwsbnVsbD09dT9cIlwiOnUpOm5bbF09bnVsbD09dT9cIlwiOlwibnVtYmVyXCIhPXR5cGVvZiB1fHx5LnRlc3QobCk/dTp1K1wicHhcIn1mdW5jdGlvbiBGKG4sbCx1LHQsaSl7dmFyIHIsbztuOmlmKFwic3R5bGVcIj09bClpZihcInN0cmluZ1wiPT10eXBlb2YgdSluLnN0eWxlLmNzc1RleHQ9dTtlbHNle2lmKFwic3RyaW5nXCI9PXR5cGVvZiB0JiYobi5zdHlsZS5jc3NUZXh0PXQ9XCJcIiksdClmb3IobCBpbiB0KXUmJmwgaW4gdXx8aihuLnN0eWxlLGwsXCJcIik7aWYodSlmb3IobCBpbiB1KXQmJnVbbF09PXRbbF18fGoobi5zdHlsZSxsLHVbbF0pfWVsc2UgaWYoXCJvXCI9PWxbMF0mJlwiblwiPT1sWzFdKXI9bCE9KGw9bC5yZXBsYWNlKGYsXCIkMVwiKSksbz1sLnRvTG93ZXJDYXNlKCksbD1vIGluIG58fFwib25Gb2N1c091dFwiPT1sfHxcIm9uRm9jdXNJblwiPT1sP28uc2xpY2UoMik6bC5zbGljZSgyKSxuLmx8fChuLmw9e30pLG4ubFtsK3JdPXUsdT90P3UudT10LnU6KHUudT1jLG4uYWRkRXZlbnRMaXN0ZW5lcihsLHI/YTpzLHIpKTpuLnJlbW92ZUV2ZW50TGlzdGVuZXIobCxyP2E6cyxyKTtlbHNle2lmKFwiaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmdcIj09aSlsPWwucmVwbGFjZSgveGxpbmsoSHw6aCkvLFwiaFwiKS5yZXBsYWNlKC9zTmFtZSQvLFwic1wiKTtlbHNlIGlmKFwid2lkdGhcIiE9bCYmXCJoZWlnaHRcIiE9bCYmXCJocmVmXCIhPWwmJlwibGlzdFwiIT1sJiZcImZvcm1cIiE9bCYmXCJ0YWJJbmRleFwiIT1sJiZcImRvd25sb2FkXCIhPWwmJlwicm93U3BhblwiIT1sJiZcImNvbFNwYW5cIiE9bCYmXCJyb2xlXCIhPWwmJlwicG9wb3ZlclwiIT1sJiZsIGluIG4pdHJ5e25bbF09bnVsbD09dT9cIlwiOnU7YnJlYWsgbn1jYXRjaChuKXt9XCJmdW5jdGlvblwiPT10eXBlb2YgdXx8KG51bGw9PXV8fCExPT09dSYmXCItXCIhPWxbNF0/bi5yZW1vdmVBdHRyaWJ1dGUobCk6bi5zZXRBdHRyaWJ1dGUobCxcInBvcG92ZXJcIj09bCYmMT09dT9cIlwiOnUpKX19ZnVuY3Rpb24gTyhuKXtyZXR1cm4gZnVuY3Rpb24odSl7aWYodGhpcy5sKXt2YXIgdD10aGlzLmxbdS50eXBlK25dO2lmKG51bGw9PXUudCl1LnQ9YysrO2Vsc2UgaWYodS50PHQudSlyZXR1cm47cmV0dXJuIHQobC5ldmVudD9sLmV2ZW50KHUpOnUpfX19ZnVuY3Rpb24geihuLHUsdCxpLHIsbyxlLGYsYyxzKXt2YXIgYSxoLHAseSxfLG0sYixTLEMsTSwkLEksQSxILEwsVD11LnR5cGU7aWYodm9pZCAwIT09dS5jb25zdHJ1Y3RvcilyZXR1cm4gbnVsbDsxMjgmdC5fX3UmJihjPSEhKDMyJnQuX191KSxvPVtmPXUuX19lPXQuX19lXSksKGE9bC5fX2IpJiZhKHUpO246aWYoXCJmdW5jdGlvblwiPT10eXBlb2YgVCl0cnl7aWYoUz11LnByb3BzLEM9VC5wcm90b3R5cGUmJlQucHJvdG90eXBlLnJlbmRlcixNPShhPVQuY29udGV4dFR5cGUpJiZpW2EuX19jXSwkPWE/TT9NLnByb3BzLnZhbHVlOmEuX186aSx0Ll9fYz9iPShoPXUuX19jPXQuX19jKS5fXz1oLl9fRTooQz91Ll9fYz1oPW5ldyBUKFMsJCk6KHUuX19jPWg9bmV3IHgoUywkKSxoLmNvbnN0cnVjdG9yPVQsaC5yZW5kZXI9RyksTSYmTS5zdWIoaCksaC5zdGF0ZXx8KGguc3RhdGU9e30pLGguX19uPWkscD1oLl9fZD0hMCxoLl9faD1bXSxoLl9zYj1bXSksQyYmbnVsbD09aC5fX3MmJihoLl9fcz1oLnN0YXRlKSxDJiZudWxsIT1ULmdldERlcml2ZWRTdGF0ZUZyb21Qcm9wcyYmKGguX19zPT1oLnN0YXRlJiYoaC5fX3M9dyh7fSxoLl9fcykpLHcoaC5fX3MsVC5nZXREZXJpdmVkU3RhdGVGcm9tUHJvcHMoUyxoLl9fcykpKSx5PWgucHJvcHMsXz1oLnN0YXRlLGguX192PXUscClDJiZudWxsPT1ULmdldERlcml2ZWRTdGF0ZUZyb21Qcm9wcyYmbnVsbCE9aC5jb21wb25lbnRXaWxsTW91bnQmJmguY29tcG9uZW50V2lsbE1vdW50KCksQyYmbnVsbCE9aC5jb21wb25lbnREaWRNb3VudCYmaC5fX2gucHVzaChoLmNvbXBvbmVudERpZE1vdW50KTtlbHNle2lmKEMmJm51bGw9PVQuZ2V0RGVyaXZlZFN0YXRlRnJvbVByb3BzJiZTIT09eSYmbnVsbCE9aC5jb21wb25lbnRXaWxsUmVjZWl2ZVByb3BzJiZoLmNvbXBvbmVudFdpbGxSZWNlaXZlUHJvcHMoUywkKSx1Ll9fdj09dC5fX3Z8fCFoLl9fZSYmbnVsbCE9aC5zaG91bGRDb21wb25lbnRVcGRhdGUmJiExPT09aC5zaG91bGRDb21wb25lbnRVcGRhdGUoUyxoLl9fcywkKSl7dS5fX3YhPXQuX192JiYoaC5wcm9wcz1TLGguc3RhdGU9aC5fX3MsaC5fX2Q9ITEpLHUuX19lPXQuX19lLHUuX19rPXQuX19rLHUuX19rLnNvbWUoZnVuY3Rpb24obil7biYmKG4uX189dSl9KSx2LnB1c2guYXBwbHkoaC5fX2gsaC5fc2IpLGguX3NiPVtdLGguX19oLmxlbmd0aCYmZS5wdXNoKGgpO2JyZWFrIG59bnVsbCE9aC5jb21wb25lbnRXaWxsVXBkYXRlJiZoLmNvbXBvbmVudFdpbGxVcGRhdGUoUyxoLl9fcywkKSxDJiZudWxsIT1oLmNvbXBvbmVudERpZFVwZGF0ZSYmaC5fX2gucHVzaChmdW5jdGlvbigpe2guY29tcG9uZW50RGlkVXBkYXRlKHksXyxtKX0pfWlmKGguY29udGV4dD0kLGgucHJvcHM9UyxoLl9fUD1uLGguX19lPSExLEk9bC5fX3IsQT0wLEMpaC5zdGF0ZT1oLl9fcyxoLl9fZD0hMSxJJiZJKHUpLGE9aC5yZW5kZXIoaC5wcm9wcyxoLnN0YXRlLGguY29udGV4dCksdi5wdXNoLmFwcGx5KGguX19oLGguX3NiKSxoLl9zYj1bXTtlbHNlIGRve2guX19kPSExLEkmJkkodSksYT1oLnJlbmRlcihoLnByb3BzLGguc3RhdGUsaC5jb250ZXh0KSxoLnN0YXRlPWguX19zfXdoaWxlKGguX19kJiYrK0E8MjUpO2guc3RhdGU9aC5fX3MsbnVsbCE9aC5nZXRDaGlsZENvbnRleHQmJihpPXcodyh7fSxpKSxoLmdldENoaWxkQ29udGV4dCgpKSksQyYmIXAmJm51bGwhPWguZ2V0U25hcHNob3RCZWZvcmVVcGRhdGUmJihtPWguZ2V0U25hcHNob3RCZWZvcmVVcGRhdGUoeSxfKSksSD1udWxsIT1hJiZhLnR5cGU9PT1rJiZudWxsPT1hLmtleT9xKGEucHJvcHMuY2hpbGRyZW4pOmEsZj1QKG4sZChIKT9IOltIXSx1LHQsaSxyLG8sZSxmLGMscyksaC5iYXNlPXUuX19lLHUuX191Jj0tMTYxLGguX19oLmxlbmd0aCYmZS5wdXNoKGgpLGImJihoLl9fRT1oLl9fPW51bGwpfWNhdGNoKG4pe2lmKHUuX192PW51bGwsY3x8bnVsbCE9bylpZihuLnRoZW4pe2Zvcih1Ll9fdXw9Yz8xNjA6MTI4O2YmJjg9PWYubm9kZVR5cGUmJmYubmV4dFNpYmxpbmc7KWY9Zi5uZXh0U2libGluZztvW28uaW5kZXhPZihmKV09bnVsbCx1Ll9fZT1mfWVsc2V7Zm9yKEw9by5sZW5ndGg7TC0tOylnKG9bTF0pO04odSl9ZWxzZSB1Ll9fZT10Ll9fZSx1Ll9faz10Ll9fayxuLnRoZW58fE4odSk7bC5fX2Uobix1LHQpfWVsc2UgbnVsbD09byYmdS5fX3Y9PXQuX192Pyh1Ll9faz10Ll9fayx1Ll9fZT10Ll9fZSk6Zj11Ll9fZT1CKHQuX19lLHUsdCxpLHIsbyxlLGMscyk7cmV0dXJuKGE9bC5kaWZmZWQpJiZhKHUpLDEyOCZ1Ll9fdT92b2lkIDA6Zn1mdW5jdGlvbiBOKG4pe24mJihuLl9fYyYmKG4uX19jLl9fZT0hMCksbi5fX2smJm4uX19rLnNvbWUoTikpfWZ1bmN0aW9uIFYobix1LHQpe2Zvcih2YXIgaT0wO2k8dC5sZW5ndGg7aSsrKUQodFtpXSx0WysraV0sdFsrK2ldKTtsLl9fYyYmbC5fX2ModSxuKSxuLnNvbWUoZnVuY3Rpb24odSl7dHJ5e249dS5fX2gsdS5fX2g9W10sbi5zb21lKGZ1bmN0aW9uKG4pe24uY2FsbCh1KX0pfWNhdGNoKG4pe2wuX19lKG4sdS5fX3YpfX0pfWZ1bmN0aW9uIHEobil7cmV0dXJuXCJvYmplY3RcIiE9dHlwZW9mIG58fG51bGw9PW58fG4uX19iPjA/bjpkKG4pP24ubWFwKHEpOncoe30sbil9ZnVuY3Rpb24gQih1LHQsaSxyLG8sZSxmLGMscyl7dmFyIGEsaCx2LHksdyxfLG0sYj1pLnByb3BzfHxwLGs9dC5wcm9wcyx4PXQudHlwZTtpZihcInN2Z1wiPT14P289XCJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2Z1wiOlwibWF0aFwiPT14P289XCJodHRwOi8vd3d3LnczLm9yZy8xOTk4L01hdGgvTWF0aE1MXCI6b3x8KG89XCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sXCIpLG51bGwhPWUpZm9yKGE9MDthPGUubGVuZ3RoO2ErKylpZigodz1lW2FdKSYmXCJzZXRBdHRyaWJ1dGVcImluIHc9PSEheCYmKHg/dy5sb2NhbE5hbWU9PXg6Mz09dy5ub2RlVHlwZSkpe3U9dyxlW2FdPW51bGw7YnJlYWt9aWYobnVsbD09dSl7aWYobnVsbD09eClyZXR1cm4gZG9jdW1lbnQuY3JlYXRlVGV4dE5vZGUoayk7dT1kb2N1bWVudC5jcmVhdGVFbGVtZW50TlMobyx4LGsuaXMmJmspLGMmJihsLl9fbSYmbC5fX20odCxlKSxjPSExKSxlPW51bGx9aWYobnVsbD09eCliPT09a3x8YyYmdS5kYXRhPT1rfHwodS5kYXRhPWspO2Vsc2V7aWYoZT1lJiZuLmNhbGwodS5jaGlsZE5vZGVzKSwhYyYmbnVsbCE9ZSlmb3IoYj17fSxhPTA7YTx1LmF0dHJpYnV0ZXMubGVuZ3RoO2ErKyliWyh3PXUuYXR0cmlidXRlc1thXSkubmFtZV09dy52YWx1ZTtmb3IoYSBpbiBiKXc9YlthXSxcImRhbmdlcm91c2x5U2V0SW5uZXJIVE1MXCI9PWE/dj13OlwiY2hpbGRyZW5cIj09YXx8YSBpbiBrfHxcInZhbHVlXCI9PWEmJlwiZGVmYXVsdFZhbHVlXCJpbiBrfHxcImNoZWNrZWRcIj09YSYmXCJkZWZhdWx0Q2hlY2tlZFwiaW4ga3x8Rih1LGEsbnVsbCx3LG8pO2ZvcihhIGluIGspdz1rW2FdLFwiY2hpbGRyZW5cIj09YT95PXc6XCJkYW5nZXJvdXNseVNldElubmVySFRNTFwiPT1hP2g9dzpcInZhbHVlXCI9PWE/Xz13OlwiY2hlY2tlZFwiPT1hP209dzpjJiZcImZ1bmN0aW9uXCIhPXR5cGVvZiB3fHxiW2FdPT09d3x8Rih1LGEsdyxiW2FdLG8pO2lmKGgpY3x8diYmKGguX19odG1sPT12Ll9faHRtbHx8aC5fX2h0bWw9PXUuaW5uZXJIVE1MKXx8KHUuaW5uZXJIVE1MPWguX19odG1sKSx0Ll9faz1bXTtlbHNlIGlmKHYmJih1LmlubmVySFRNTD1cIlwiKSxQKFwidGVtcGxhdGVcIj09dC50eXBlP3UuY29udGVudDp1LGQoeSk/eTpbeV0sdCxpLHIsXCJmb3JlaWduT2JqZWN0XCI9PXg/XCJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hodG1sXCI6byxlLGYsZT9lWzBdOmkuX19rJiZTKGksMCksYyxzKSxudWxsIT1lKWZvcihhPWUubGVuZ3RoO2EtLTspZyhlW2FdKTtjfHwoYT1cInZhbHVlXCIsXCJwcm9ncmVzc1wiPT14JiZudWxsPT1fP3UucmVtb3ZlQXR0cmlidXRlKFwidmFsdWVcIik6bnVsbCE9XyYmKF8hPT11W2FdfHxcInByb2dyZXNzXCI9PXgmJiFffHxcIm9wdGlvblwiPT14JiZfIT1iW2FdKSYmRih1LGEsXyxiW2FdLG8pLGE9XCJjaGVja2VkXCIsbnVsbCE9bSYmbSE9dVthXSYmRih1LGEsbSxiW2FdLG8pKX1yZXR1cm4gdX1mdW5jdGlvbiBEKG4sdSx0KXt0cnl7aWYoXCJmdW5jdGlvblwiPT10eXBlb2Ygbil7dmFyIGk9XCJmdW5jdGlvblwiPT10eXBlb2Ygbi5fX3U7aSYmbi5fX3UoKSxpJiZudWxsPT11fHwobi5fX3U9bih1KSl9ZWxzZSBuLmN1cnJlbnQ9dX1jYXRjaChuKXtsLl9fZShuLHQpfX1mdW5jdGlvbiBFKG4sdSx0KXt2YXIgaSxyO2lmKGwudW5tb3VudCYmbC51bm1vdW50KG4pLChpPW4ucmVmKSYmKGkuY3VycmVudCYmaS5jdXJyZW50IT1uLl9fZXx8RChpLG51bGwsdSkpLG51bGwhPShpPW4uX19jKSl7aWYoaS5jb21wb25lbnRXaWxsVW5tb3VudCl0cnl7aS5jb21wb25lbnRXaWxsVW5tb3VudCgpfWNhdGNoKG4pe2wuX19lKG4sdSl9aS5iYXNlPWkuX19QPW51bGx9aWYoaT1uLl9faylmb3Iocj0wO3I8aS5sZW5ndGg7cisrKWlbcl0mJkUoaVtyXSx1LHR8fFwiZnVuY3Rpb25cIiE9dHlwZW9mIG4udHlwZSk7dHx8ZyhuLl9fZSksbi5fX2M9bi5fXz1uLl9fZT12b2lkIDB9ZnVuY3Rpb24gRyhuLGwsdSl7cmV0dXJuIHRoaXMuY29uc3RydWN0b3Iobix1KX1mdW5jdGlvbiBKKHUsdCxpKXt2YXIgcixvLGUsZjt0PT1kb2N1bWVudCYmKHQ9ZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50KSxsLl9fJiZsLl9fKHUsdCksbz0ocj1cImZ1bmN0aW9uXCI9PXR5cGVvZiBpKT9udWxsOmkmJmkuX19rfHx0Ll9fayxlPVtdLGY9W10seih0LHU9KCFyJiZpfHx0KS5fX2s9XyhrLG51bGwsW3VdKSxvfHxwLHAsdC5uYW1lc3BhY2VVUkksIXImJmk/W2ldOm8/bnVsbDp0LmZpcnN0Q2hpbGQ/bi5jYWxsKHQuY2hpbGROb2Rlcyk6bnVsbCxlLCFyJiZpP2k6bz9vLl9fZTp0LmZpcnN0Q2hpbGQscixmKSxWKGUsdSxmKX1mdW5jdGlvbiBLKG4sbCl7SihuLGwsSyl9ZnVuY3Rpb24gUShsLHUsdCl7dmFyIGkscixvLGUsZj13KHt9LGwucHJvcHMpO2ZvcihvIGluIGwudHlwZSYmbC50eXBlLmRlZmF1bHRQcm9wcyYmKGU9bC50eXBlLmRlZmF1bHRQcm9wcyksdSlcImtleVwiPT1vP2k9dVtvXTpcInJlZlwiPT1vP3I9dVtvXTpmW29dPXZvaWQgMD09PXVbb10mJm51bGwhPWU/ZVtvXTp1W29dO3JldHVybiBhcmd1bWVudHMubGVuZ3RoPjImJihmLmNoaWxkcmVuPWFyZ3VtZW50cy5sZW5ndGg+Mz9uLmNhbGwoYXJndW1lbnRzLDIpOnQpLG0obC50eXBlLGYsaXx8bC5rZXkscnx8bC5yZWYsbnVsbCl9ZnVuY3Rpb24gUihuKXtmdW5jdGlvbiBsKG4pe3ZhciB1LHQ7cmV0dXJuIHRoaXMuZ2V0Q2hpbGRDb250ZXh0fHwodT1uZXcgU2V0LCh0PXt9KVtsLl9fY109dGhpcyx0aGlzLmdldENoaWxkQ29udGV4dD1mdW5jdGlvbigpe3JldHVybiB0fSx0aGlzLmNvbXBvbmVudFdpbGxVbm1vdW50PWZ1bmN0aW9uKCl7dT1udWxsfSx0aGlzLnNob3VsZENvbXBvbmVudFVwZGF0ZT1mdW5jdGlvbihuKXt0aGlzLnByb3BzLnZhbHVlIT1uLnZhbHVlJiZ1LmZvckVhY2goZnVuY3Rpb24obil7bi5fX2U9ITAsJChuKX0pfSx0aGlzLnN1Yj1mdW5jdGlvbihuKXt1LmFkZChuKTt2YXIgbD1uLmNvbXBvbmVudFdpbGxVbm1vdW50O24uY29tcG9uZW50V2lsbFVubW91bnQ9ZnVuY3Rpb24oKXt1JiZ1LmRlbGV0ZShuKSxsJiZsLmNhbGwobil9fSksbi5jaGlsZHJlbn1yZXR1cm4gbC5fX2M9XCJfX2NDXCIraCsrLGwuX189bixsLlByb3ZpZGVyPWwuX19sPShsLkNvbnN1bWVyPWZ1bmN0aW9uKG4sbCl7cmV0dXJuIG4uY2hpbGRyZW4obCl9KS5jb250ZXh0VHlwZT1sLGx9bj12LnNsaWNlLGw9e19fZTpmdW5jdGlvbihuLGwsdSx0KXtmb3IodmFyIGkscixvO2w9bC5fXzspaWYoKGk9bC5fX2MpJiYhaS5fXyl0cnl7aWYoKHI9aS5jb25zdHJ1Y3RvcikmJm51bGwhPXIuZ2V0RGVyaXZlZFN0YXRlRnJvbUVycm9yJiYoaS5zZXRTdGF0ZShyLmdldERlcml2ZWRTdGF0ZUZyb21FcnJvcihuKSksbz1pLl9fZCksbnVsbCE9aS5jb21wb25lbnREaWRDYXRjaCYmKGkuY29tcG9uZW50RGlkQ2F0Y2gobix0fHx7fSksbz1pLl9fZCksbylyZXR1cm4gaS5fX0U9aX1jYXRjaChsKXtuPWx9dGhyb3cgbn19LHU9MCx0PWZ1bmN0aW9uKG4pe3JldHVybiBudWxsIT1uJiZ2b2lkIDA9PT1uLmNvbnN0cnVjdG9yfSx4LnByb3RvdHlwZS5zZXRTdGF0ZT1mdW5jdGlvbihuLGwpe3ZhciB1O3U9bnVsbCE9dGhpcy5fX3MmJnRoaXMuX19zIT10aGlzLnN0YXRlP3RoaXMuX19zOnRoaXMuX19zPXcoe30sdGhpcy5zdGF0ZSksXCJmdW5jdGlvblwiPT10eXBlb2YgbiYmKG49bih3KHt9LHUpLHRoaXMucHJvcHMpKSxuJiZ3KHUsbiksbnVsbCE9biYmdGhpcy5fX3YmJihsJiZ0aGlzLl9zYi5wdXNoKGwpLCQodGhpcykpfSx4LnByb3RvdHlwZS5mb3JjZVVwZGF0ZT1mdW5jdGlvbihuKXt0aGlzLl9fdiYmKHRoaXMuX19lPSEwLG4mJnRoaXMuX19oLnB1c2gobiksJCh0aGlzKSl9LHgucHJvdG90eXBlLnJlbmRlcj1rLGk9W10sbz1cImZ1bmN0aW9uXCI9PXR5cGVvZiBQcm9taXNlP1Byb21pc2UucHJvdG90eXBlLnRoZW4uYmluZChQcm9taXNlLnJlc29sdmUoKSk6c2V0VGltZW91dCxlPWZ1bmN0aW9uKG4sbCl7cmV0dXJuIG4uX192Ll9fYi1sLl9fdi5fX2J9LEkuX19yPTAsZj0vKFBvaW50ZXJDYXB0dXJlKSR8Q2FwdHVyZSQvaSxjPTAscz1PKCExKSxhPU8oITApLGg9MDtleHBvcnR7eCBhcyBDb21wb25lbnQsayBhcyBGcmFnbWVudCxRIGFzIGNsb25lRWxlbWVudCxSIGFzIGNyZWF0ZUNvbnRleHQsXyBhcyBjcmVhdGVFbGVtZW50LGIgYXMgY3JlYXRlUmVmLF8gYXMgaCxLIGFzIGh5ZHJhdGUsdCBhcyBpc1ZhbGlkRWxlbWVudCxsIGFzIG9wdGlvbnMsSiBhcyByZW5kZXIsTCBhcyB0b0NoaWxkQXJyYXl9O1xuLy8jIHNvdXJjZU1hcHBpbmdVUkw9cHJlYWN0Lm1vZHVsZS5qcy5tYXBcbiIsCiAgICAiLyoqXG4gKiBTaWduYWxzIFRlc3QgUGFnZSDigJQgaXNvbGF0ZWQgc2FuZGJveCB0byB2YWxpZGF0ZSBAcHJlYWN0L3NpZ25hbHMgcGF0dGVybnNcbiAqIGJlZm9yZSBhcHBseWluZyB0aGVtIHRvIHRoZSBwcm9kdWN0aW9uIGFwcC5cbiAqXG4gKiBUZXN0czpcbiAqIDEuIEF1dG8tc3Vic2NyaWJlOiBzaWduYWwudmFsdWUgaW4gSlNYIOKGkiByZS1yZW5kZXIgb24gY2hhbmdlP1xuICogMi4gdXNlU2lnbmFsRWZmZWN0IGJyaWRnZTogc2lnbmFsIOKGkiB1c2VTdGF0ZSDihpIgcmUtcmVuZGVyXG4gKiAzLiBjcmVhdGVNb2RlbCArIHVzZU1vZGVsIGxpZmVjeWNsZVxuICogNC4gTW9kYWwgcGF0dGVybjogY29uZGl0aW9uYWwgcmVuZGVyIGJhc2VkIG9uIHNpZ25hbCAodGhlIGJyb2tlbiBjYXNlKVxuICogNS4gQ29tcHV0ZWQgc2lnbmFsc1xuICogNi4gYWN0aW9uKCkgYmF0Y2hpbmdcbiAqL1xuaW1wb3J0IHsgcmVuZGVyIH0gZnJvbSBcInByZWFjdFwiO1xuaW1wb3J0IHsgdXNlU3RhdGUgfSBmcm9tIFwicHJlYWN0L2hvb2tzXCI7XG5pbXBvcnQgXCJAcHJlYWN0L3NpZ25hbHNcIjsgLy8gc2lkZS1lZmZlY3Q6IGluc3RhbGwgb3B0aW9ucyBob29rc1xuaW1wb3J0IHtcbiAgc2lnbmFsLFxuICBjb21wdXRlZCxcbiAgZWZmZWN0LFxuICBhY3Rpb24sXG4gIGJhdGNoLFxuICBjcmVhdGVNb2RlbCxcbiAgdXNlTW9kZWwsXG4gIHVzZVNpZ25hbCxcbiAgdXNlU2lnbmFsRWZmZWN0LFxuICB1c2VDb21wdXRlZCxcbn0gZnJvbSBcIkBwcmVhY3Qvc2lnbmFsc1wiO1xuaW1wb3J0IHsgU2hvdywgRm9yIH0gZnJvbSBcIkBwcmVhY3Qvc2lnbmFscy91dGlsc1wiO1xuXG4vLyDilIDilIDilIAgVGVzdCBpbmZyYXN0cnVjdHVyZSDilIDilIDilIBcbmNvbnN0IHJlc3VsdHMgPSBzaWduYWw8QXJyYXk8eyBuYW1lOiBzdHJpbmc7IHBhc3M6IGJvb2xlYW47IGRldGFpbDogc3RyaW5nIH0+PihbXSk7XG5cbmZ1bmN0aW9uIGxvZyhuYW1lOiBzdHJpbmcsIHBhc3M6IGJvb2xlYW4sIGRldGFpbCA9IFwiXCIpIHtcbiAgcmVzdWx0cy52YWx1ZSA9IFsuLi5yZXN1bHRzLnZhbHVlLCB7IG5hbWUsIHBhc3MsIGRldGFpbCB9XTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgMTogQXV0by1zdWJzY3JpYmUg4pSA4pSA4pSAXG5jb25zdCBhdXRvQ291bnQgPSBzaWduYWwoMCk7XG5sZXQgdDFSZW5kZXJzID0gMDtcblxuZnVuY3Rpb24gVGVzdDFfQXV0b1N1YnNjcmliZSgpIHtcbiAgdDFSZW5kZXJzKys7XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCAxOiBBdXRvLXN1YnNjcmliZTwvaDM+XG4gICAgICA8cD5cbiAgICAgICAgc2lnbmFsLnZhbHVlIGluIEpTWDogPHN0cm9uZz57YXV0b0NvdW50LnZhbHVlfTwvc3Ryb25nPlxuICAgICAgPC9wPlxuICAgICAgPHAgY2xhc3M9XCJkaW1cIj5Db21wb25lbnQgcmVuZGVyczoge3QxUmVuZGVyc308L3A+XG4gICAgICA8YnV0dG9uXG4gICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICBhdXRvQ291bnQudmFsdWUrKztcbiAgICAgICAgfX1cbiAgICAgID5cbiAgICAgICAgSW5jcmVtZW50XG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBJZiB0aGUgbnVtYmVyIHVwZGF0ZXMgd2hlbiB5b3UgY2xpY2ssIGF1dG8tc3Vic2NyaWJlIHdvcmtzIHdpdGggQnVuJ3NcbiAgICAgICAgYnVuZGxlci5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgMjogdXNlU2lnbmFsRWZmZWN0IGJyaWRnZSDilIDilIDilIBcbmNvbnN0IGJyaWRnZVNpZ25hbCA9IHNpZ25hbCgwKTtcblxuZnVuY3Rpb24gVGVzdDJfQnJpZGdlKCkge1xuICBjb25zdCBbbG9jYWwsIHNldExvY2FsXSA9IHVzZVN0YXRlKGJyaWRnZVNpZ25hbC52YWx1ZSk7XG4gIHVzZVNpZ25hbEVmZmVjdCgoKSA9PiB7XG4gICAgc2V0TG9jYWwoYnJpZGdlU2lnbmFsLnZhbHVlKTtcbiAgfSk7XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCAyOiB1c2VTaWduYWxFZmZlY3QgYnJpZGdlPC9oMz5cbiAgICAgIDxwPlxuICAgICAgICBTaWduYWw6IDxzdHJvbmcgaWQ9XCJ0Mi1zaWduYWxcIj57YnJpZGdlU2lnbmFsLnZhbHVlfTwvc3Ryb25nPiB8IExvY2FsXG4gICAgICAgIHN0YXRlOiA8c3Ryb25nIGlkPVwidDItbG9jYWxcIj57bG9jYWx9PC9zdHJvbmc+XG4gICAgICA8L3A+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgYnJpZGdlU2lnbmFsLnZhbHVlKys7IH19PlxuICAgICAgICBJbmNyZW1lbnQgc2lnbmFsXG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBCb3RoIG51bWJlcnMgc2hvdWxkIHVwZGF0ZSB0b2dldGhlci4gSWYgb25seSBcIlNpZ25hbFwiIHVwZGF0ZXMsIGF1dG8tc3Vic2NyaWJlIHdvcmtzXG4gICAgICAgIGJ1dCBicmlkZ2UgaXMgcmVkdW5kYW50LiBJZiBuZWl0aGVyIHVwZGF0ZXMsIGJvdGggYXJlIGJyb2tlbi5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgMzogY3JlYXRlTW9kZWwgKyB1c2VNb2RlbCDilIDilIDilIBcbmNvbnN0IENvdW50ZXJNb2RlbCA9IGNyZWF0ZU1vZGVsKCgpID0+IHtcbiAgY29uc3QgY291bnQgPSBzaWduYWwoMCk7XG4gIGNvbnN0IGRvdWJsZWQgPSBjb21wdXRlZCgoKSA9PiBjb3VudC52YWx1ZSAqIDIpO1xuICBjb25zdCBpbmNyZW1lbnQgPSBhY3Rpb24oKCkgPT4geyBjb3VudC52YWx1ZSsrOyB9KTtcbiAgY29uc3QgcmVzZXQgPSBhY3Rpb24oKCkgPT4geyBjb3VudC52YWx1ZSA9IDA7IH0pO1xuICByZXR1cm4geyBjb3VudCwgZG91YmxlZCwgaW5jcmVtZW50LCByZXNldCB9O1xufSk7XG5cbmZ1bmN0aW9uIFRlc3QzX01vZGVsKCkge1xuICBjb25zdCBtID0gdXNlTW9kZWwoQ291bnRlck1vZGVsKTtcbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCAzOiBjcmVhdGVNb2RlbCArIHVzZU1vZGVsPC9oMz5cbiAgICAgIDxwPlxuICAgICAgICBDb3VudDogPHN0cm9uZz57bS5jb3VudC52YWx1ZX08L3N0cm9uZz4gfCBEb3VibGVkOntcIiBcIn1cbiAgICAgICAgPHN0cm9uZz57bS5kb3VibGVkLnZhbHVlfTwvc3Ryb25nPlxuICAgICAgPC9wPlxuICAgICAgPGJ1dHRvbiBvbkNsaWNrPXttLmluY3JlbWVudH0+KzE8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gb25DbGljaz17bS5yZXNldH0+UmVzZXQ8L2J1dHRvbj5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBUZXN0cyBtb2RlbCBjcmVhdGlvbiwgY29tcHV0ZWQgZGVyaXZhdGlvbiwgYW5kIGFjdGlvbiBiYXRjaGluZy5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgNDogTW9kYWwgcGF0dGVybiAoVEhFIGJyb2tlbiBjYXNlKSDilIDilIDilIBcbmNvbnN0IG1vZGFsRXZlbnQgPSBzaWduYWw8eyBpZDogbnVtYmVyOyBuYW1lOiBzdHJpbmcgfSB8IG51bGw+KG51bGwpO1xuXG5mdW5jdGlvbiBUZXN0NF9Nb2RhbCgpIHtcbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCA0OiBNb2RhbCAoY29uZGl0aW9uYWwgcmVuZGVyIGZyb20gc2lnbmFsKTwvaDM+XG4gICAgICA8YnV0dG9uXG4gICAgICAgIG9uQ2xpY2s9eygpID0+IHtcbiAgICAgICAgICBtb2RhbEV2ZW50LnZhbHVlID0geyBpZDogMSwgbmFtZTogXCJDYXQgZGV0ZWN0ZWQhXCIgfTtcbiAgICAgICAgfX1cbiAgICAgID5cbiAgICAgICAgT3BlbiBNb2RhbFxuICAgICAgPC9idXR0b24+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgbW9kYWxFdmVudC52YWx1ZSA9IG51bGw7IH19PlxuICAgICAgICBDbG9zZSBNb2RhbFxuICAgICAgPC9idXR0b24+XG4gICAgICA8cD5cbiAgICAgICAgbW9kYWxFdmVudDogPGNvZGU+e0pTT04uc3RyaW5naWZ5KG1vZGFsRXZlbnQudmFsdWUpfTwvY29kZT5cbiAgICAgIDwvcD5cbiAgICAgIHttb2RhbEV2ZW50LnZhbHVlICYmIChcbiAgICAgICAgPGRpdiBjbGFzcz1cIm1vY2stbW9kYWxcIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbC1jb250ZW50XCI+XG4gICAgICAgICAgICA8c3Ryb25nPk1vZGFsIE9wZW4hPC9zdHJvbmc+XG4gICAgICAgICAgICA8cD5FdmVudDoge21vZGFsRXZlbnQudmFsdWUubmFtZX0gKGlkPXttb2RhbEV2ZW50LnZhbHVlLmlkfSk8L3A+XG4gICAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgbW9kYWxFdmVudC52YWx1ZSA9IG51bGw7IH19PsOXPC9idXR0b24+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgIDwvZGl2PlxuICAgICAgKX1cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBJZiB0aGUgbW9kYWwgZG9lcyBOT1QgYXBwZWFyIHdoZW4gY2xpY2tpbmcgXCJPcGVuIE1vZGFsXCIsIGF1dG8tc3Vic2NyaWJlXG4gICAgICAgIGlzIGJyb2tlbiBhbmQgdGhlIGNvbXBvbmVudCBkb2Vzbid0IHJlLXJlbmRlciBvbiBzaWduYWwgY2hhbmdlLlxuICAgICAgPC9wPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG4vLyDilIDilIDilIAgVGVzdCA0YjogTW9kYWwgd2l0aCB1c2VTaWduYWxFZmZlY3QgYnJpZGdlICh3b3JrYXJvdW5kKSDilIDilIDilIBcbmZ1bmN0aW9uIFRlc3Q0Yl9Nb2RhbEJyaWRnZSgpIHtcbiAgY29uc3QgW2V2LCBzZXRFdl0gPSB1c2VTdGF0ZShtb2RhbEV2ZW50LnZhbHVlKTtcbiAgdXNlU2lnbmFsRWZmZWN0KCgpID0+IHtcbiAgICBzZXRFdihtb2RhbEV2ZW50LnZhbHVlKTtcbiAgfSk7XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCA0YjogTW9kYWwgKGJyaWRnZSB3b3JrYXJvdW5kKTwvaDM+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgbW9kYWxFdmVudC52YWx1ZSA9IHsgaWQ6IDIsIG5hbWU6IFwiRG9nIGRldGVjdGVkIVwiIH07IH19PlxuICAgICAgICBPcGVuIE1vZGFsXG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBtb2RhbEV2ZW50LnZhbHVlID0gbnVsbDsgfX0+Q2xvc2U8L2J1dHRvbj5cbiAgICAgIDxwPlxuICAgICAgICBsb2NhbCBldjogPGNvZGU+e0pTT04uc3RyaW5naWZ5KGV2KX08L2NvZGU+XG4gICAgICA8L3A+XG4gICAgICB7ZXYgJiYgKFxuICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbFwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJtb2NrLW1vZGFsLWNvbnRlbnRcIj5cbiAgICAgICAgICAgIDxzdHJvbmc+QnJpZGdlIE1vZGFsIE9wZW4hPC9zdHJvbmc+XG4gICAgICAgICAgICA8cD5FdmVudDoge2V2Lm5hbWV9IChpZD17ZXYuaWR9KTwvcD5cbiAgICAgICAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBtb2RhbEV2ZW50LnZhbHVlID0gbnVsbDsgfX0+w5c8L2J1dHRvbj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgPC9kaXY+XG4gICAgICApfVxuICAgICAgPHAgY2xhc3M9XCJoaW50XCI+U2FtZSBtb2RhbCBidXQgdXNpbmcgdXNlU2lnbmFsRWZmZWN04oaSdXNlU3RhdGUgYnJpZGdlLjwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgNTogdXNlTW9kZWwgbW9kYWwgcGF0dGVybiAobWltaWNzIHByb2R1Y3Rpb24gYXBwLnRzeCkg4pSA4pSA4pSAXG5jb25zdCBNb2RhbFN0b3JlID0gY3JlYXRlTW9kZWwoKCkgPT4ge1xuICBjb25zdCBzZWxlY3RlZCA9IHNpZ25hbDx7IGlkOiBudW1iZXI7IG5hbWU6IHN0cmluZyB9IHwgbnVsbD4obnVsbCk7XG4gIGNvbnN0IGl0ZW1zID0gc2lnbmFsKFtcbiAgICB7IGlkOiAxLCBuYW1lOiBcIkNoYXRvcmEgc2xlZXBpbmdcIiB9LFxuICAgIHsgaWQ6IDIsIG5hbWU6IFwiTWlrZSBlYXRpbmdcIiB9LFxuICAgIHsgaWQ6IDMsIG5hbWU6IFwiS2lqaXRvcmEgcGxheWluZ1wiIH0sXG4gIF0pO1xuICBjb25zdCBvcGVuTW9kYWwgPSBhY3Rpb24oKGl0ZW06IHsgaWQ6IG51bWJlcjsgbmFtZTogc3RyaW5nIH0pID0+IHtcbiAgICBzZWxlY3RlZC52YWx1ZSA9IGl0ZW07XG4gIH0pO1xuICBjb25zdCBjbG9zZU1vZGFsID0gYWN0aW9uKCgpID0+IHtcbiAgICBzZWxlY3RlZC52YWx1ZSA9IG51bGw7XG4gIH0pO1xuICByZXR1cm4geyBzZWxlY3RlZCwgaXRlbXMsIG9wZW5Nb2RhbCwgY2xvc2VNb2RhbCB9O1xufSk7XG5cbmZ1bmN0aW9uIFRlc3Q1X1N0b3JlTW9kYWwoKSB7XG4gIGNvbnN0IHN0b3JlID0gdXNlTW9kZWwoTW9kYWxTdG9yZSk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgNTogdXNlTW9kZWwgKyBtb2RhbCAocHJvZHVjdGlvbiBwYXR0ZXJuKTwvaDM+XG4gICAgICA8ZGl2IGNsYXNzPVwiaXRlbS1saXN0XCI+XG4gICAgICAgIHtzdG9yZS5pdGVtcy52YWx1ZS5tYXAoKGl0ZW0pID0+IChcbiAgICAgICAgICA8YnV0dG9uIGtleT17aXRlbS5pZH0gb25DbGljaz17KCkgPT4gc3RvcmUub3Blbk1vZGFsKGl0ZW0pfT5cbiAgICAgICAgICAgIHtpdGVtLm5hbWV9XG4gICAgICAgICAgPC9idXR0b24+XG4gICAgICAgICkpfVxuICAgICAgPC9kaXY+XG4gICAgICA8cD5cbiAgICAgICAgc2VsZWN0ZWQ6IDxjb2RlPntKU09OLnN0cmluZ2lmeShzdG9yZS5zZWxlY3RlZC52YWx1ZSl9PC9jb2RlPlxuICAgICAgPC9wPlxuICAgICAge3N0b3JlLnNlbGVjdGVkLnZhbHVlICYmIChcbiAgICAgICAgPGRpdiBjbGFzcz1cIm1vY2stbW9kYWxcIj5cbiAgICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbC1jb250ZW50XCI+XG4gICAgICAgICAgICA8c3Ryb25nPntzdG9yZS5zZWxlY3RlZC52YWx1ZS5uYW1lfTwvc3Ryb25nPlxuICAgICAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXtzdG9yZS5jbG9zZU1vZGFsfT7DlzwvYnV0dG9uPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICAgICl9XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5cbiAgICAgICAgVGhpcyBpcyB0aGUgZXhhY3QgcGF0dGVybiBmcm9tIGFwcC50c3guIElmIHRoZSBtb2RhbCBkb2Vzbid0IGFwcGVhcixcbiAgICAgICAgY3JlYXRlTW9kZWwgKyBhdXRvLXN1YnNjcmliZSBpcyB0aGUgcHJvYmxlbS5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgNWI6IHVzZU1vZGVsICsgYnJpZGdlIOKUgOKUgOKUgFxuZnVuY3Rpb24gVGVzdDViX1N0b3JlTW9kYWxCcmlkZ2UoKSB7XG4gIGNvbnN0IHN0b3JlID0gdXNlTW9kZWwoTW9kYWxTdG9yZSk7XG4gIGNvbnN0IFtzZWwsIHNldFNlbF0gPSB1c2VTdGF0ZShzdG9yZS5zZWxlY3RlZC52YWx1ZSk7XG4gIHVzZVNpZ25hbEVmZmVjdCgoKSA9PiB7XG4gICAgc2V0U2VsKHN0b3JlLnNlbGVjdGVkLnZhbHVlKTtcbiAgfSk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgNWI6IHVzZU1vZGVsICsgYnJpZGdlIG1vZGFsPC9oMz5cbiAgICAgIDxkaXYgY2xhc3M9XCJpdGVtLWxpc3RcIj5cbiAgICAgICAge3N0b3JlLml0ZW1zLnZhbHVlLm1hcCgoaXRlbSkgPT4gKFxuICAgICAgICAgIDxidXR0b24ga2V5PXtpdGVtLmlkfSBvbkNsaWNrPXsoKSA9PiBzdG9yZS5vcGVuTW9kYWwoaXRlbSl9PlxuICAgICAgICAgICAge2l0ZW0ubmFtZX1cbiAgICAgICAgICA8L2J1dHRvbj5cbiAgICAgICAgKSl9XG4gICAgICA8L2Rpdj5cbiAgICAgIDxwPlxuICAgICAgICBsb2NhbCBzZWw6IDxjb2RlPntKU09OLnN0cmluZ2lmeShzZWwpfTwvY29kZT5cbiAgICAgIDwvcD5cbiAgICAgIHtzZWwgJiYgKFxuICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbFwiPlxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJtb2NrLW1vZGFsLWNvbnRlbnRcIj5cbiAgICAgICAgICAgIDxzdHJvbmc+e3NlbC5uYW1lfTwvc3Ryb25nPlxuICAgICAgICAgICAgPGJ1dHRvbiBvbkNsaWNrPXtzdG9yZS5jbG9zZU1vZGFsfT7DlzwvYnV0dG9uPlxuICAgICAgICAgIDwvZGl2PlxuICAgICAgICA8L2Rpdj5cbiAgICAgICl9XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5TYW1lIGJ1dCB3aXRoIHVzZVNpZ25hbEVmZmVjdCBicmlkZ2UuPC9wPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG4vLyDilIDilIDilIAgVGVzdCA2OiB1c2VTaWduYWwgKGxvY2FsIHNpZ25hbCkg4pSA4pSA4pSAXG5mdW5jdGlvbiBUZXN0Nl9Vc2VTaWduYWwoKSB7XG4gIGNvbnN0IGNvdW50ID0gdXNlU2lnbmFsKDApO1xuICByZXR1cm4gKFxuICAgIDxkaXYgY2xhc3M9XCJ0ZXN0LWNhcmRcIj5cbiAgICAgIDxoMz5UZXN0IDY6IHVzZVNpZ25hbCAoY29tcG9uZW50LWxvY2FsKTwvaDM+XG4gICAgICA8cD5cbiAgICAgICAgQ291bnQ6IDxzdHJvbmc+e2NvdW50LnZhbHVlfTwvc3Ryb25nPlxuICAgICAgPC9wPlxuICAgICAgPGJ1dHRvbiBvbkNsaWNrPXsoKSA9PiB7IGNvdW50LnZhbHVlKys7IH19PisxPC9idXR0b24+XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj51c2VTaWduYWwgY3JlYXRlcyBhIGNvbXBvbmVudC1zY29wZWQgc2lnbmFsLjwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgNzogdXNlQ29tcHV0ZWQg4pSA4pSA4pSAXG5mdW5jdGlvbiBUZXN0N19Vc2VDb21wdXRlZCgpIHtcbiAgY29uc3QgY291bnQgPSB1c2VTaWduYWwoMCk7XG4gIGNvbnN0IGxhYmVsID0gdXNlQ29tcHV0ZWQoKCkgPT5cbiAgICBjb3VudC52YWx1ZSA9PT0gMCA/IFwiemVyb1wiIDogY291bnQudmFsdWUgPCA1ID8gXCJmZXdcIiA6IFwibWFueVwiXG4gICk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgNzogdXNlQ29tcHV0ZWQ8L2gzPlxuICAgICAgPHA+XG4gICAgICAgIENvdW50OiA8c3Ryb25nPntjb3VudC52YWx1ZX08L3N0cm9uZz4gfCBMYWJlbDogPHN0cm9uZz57bGFiZWwudmFsdWV9PC9zdHJvbmc+XG4gICAgICA8L3A+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgY291bnQudmFsdWUrKzsgfX0+KzE8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBjb3VudC52YWx1ZSA9IDA7IH19PlJlc2V0PC9idXR0b24+XG4gICAgPC9kaXY+XG4gICk7XG59XG5cbi8vIOKUgOKUgOKUgCBUZXN0IDg6IGJhdGNoKCkgbXVsdGlwbGUgc2lnbmFsIHdyaXRlcyDilIDilIDilIBcbmNvbnN0IGJhdGNoQSA9IHNpZ25hbCgwKTtcbmNvbnN0IGJhdGNoQiA9IHNpZ25hbCgwKTtcblxuZnVuY3Rpb24gVGVzdDhfQmF0Y2goKSB7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgODogYmF0Y2goKTwvaDM+XG4gICAgICA8cD5cbiAgICAgICAgQTogPHN0cm9uZz57YmF0Y2hBLnZhbHVlfTwvc3Ryb25nPiB8IEI6IDxzdHJvbmc+e2JhdGNoQi52YWx1ZX08L3N0cm9uZz5cbiAgICAgIDwvcD5cbiAgICAgIDxidXR0b25cbiAgICAgICAgb25DbGljaz17KCkgPT4ge1xuICAgICAgICAgIGJhdGNoKCgpID0+IHtcbiAgICAgICAgICAgIGJhdGNoQS52YWx1ZSsrO1xuICAgICAgICAgICAgYmF0Y2hCLnZhbHVlICs9IDEwO1xuICAgICAgICAgIH0pO1xuICAgICAgICB9fVxuICAgICAgPlxuICAgICAgICBCYXRjaCB1cGRhdGUgKEErMSwgQisxMClcbiAgICAgIDwvYnV0dG9uPlxuICAgICAgPHAgY2xhc3M9XCJoaW50XCI+U2hvdWxkIHVwZGF0ZSBib3RoIGluIGEgc2luZ2xlIHJlbmRlci48L3A+XG4gICAgPC9kaXY+XG4gICk7XG59XG5cbi8vIOKUgOKUgOKUgCBUZXN0IDk6IERpYWdub3N0aWMg4oCUIGNoZWNrIG9wdGlvbnMgaG9va3MgYXJlIGluc3RhbGxlZCDilIDilIDilIBcbmZ1bmN0aW9uIFRlc3Q5X0RpYWdub3N0aWMoKSB7XG4gIGxldCBpbmZvOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gIHRyeSB7XG4gICAgLy8gQHRzLWlnbm9yZSDigJQgYWNjZXNzaW5nIHByZWFjdCBpbnRlcm5hbHNcbiAgICBjb25zdCBvcHRzID0gKGdsb2JhbFRoaXMgYXMgYW55KS5fX1BSRUFDVF9TSUdOQUxTX0hPT0tTX187XG4gICAgaW5mby5nbG9iYWxIb29rID0gb3B0cyA/IFwiZm91bmRcIiA6IFwibm90IGZvdW5kXCI7XG4gIH0gY2F0Y2ggeyAvKiBpZ25vcmUgKi8gfVxuXG4gIC8vIENoZWNrIGlmIHByZWFjdCBvcHRpb25zIGhhdmUgYmVlbiBwYXRjaGVkXG4gIHRyeSB7XG4gICAgY29uc3QgcHJlYWN0ID0gcmVxdWlyZShcInByZWFjdFwiKTtcbiAgICBjb25zdCBvcHRLZXlzID0gT2JqZWN0LmtleXMocHJlYWN0Lm9wdGlvbnMgfHwge30pO1xuICAgIGluZm8ucHJlYWN0T3B0aW9ucyA9IG9wdEtleXMuam9pbihcIiwgXCIpIHx8IFwiKGVtcHR5KVwiO1xuICB9IGNhdGNoIHtcbiAgICBpbmZvLnByZWFjdE9wdGlvbnMgPSBcIihjYW5ub3QgYWNjZXNzKVwiO1xuICB9XG5cbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCA5OiBEaWFnbm9zdGljczwvaDM+XG4gICAgICA8cHJlPntKU09OLnN0cmluZ2lmeShpbmZvLCBudWxsLCAyKX08L3ByZT5cbiAgICAgIDxwPlxuICAgICAgICBTaWRlLWVmZmVjdCBpbXBvcnQgcHJlc2VudDp7XCIgXCJ9XG4gICAgICAgIDxzdHJvbmc+e3R5cGVvZiBzaWduYWwgPT09IFwiZnVuY3Rpb25cIiA/IFwiWUVTXCIgOiBcIk5PXCJ9PC9zdHJvbmc+XG4gICAgICA8L3A+XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5cbiAgICAgICAgSWYgcHJlYWN0T3B0aW9ucyBzaG93cyBfX2IsIF9fciwgZGlmZmVkLCB1bm1vdW50IOKAlCBob29rcyBhcmUgaW5zdGFsbGVkLlxuICAgICAgPC9wPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG4vLyDilIDilIDilIAgVGVzdCAxMDogU2hvdyBjb21wb25lbnQgKGNvbmRpdGlvbmFsIHJlbmRlciB3aXRob3V0IHJlLXJlbmRlcikg4pSA4pSA4pSAXG5jb25zdCBzaG93U2lnbmFsID0gc2lnbmFsPHN0cmluZyB8IG51bGw+KG51bGwpO1xuXG5mdW5jdGlvbiBUZXN0MTBfU2hvdygpIHtcbiAgcmV0dXJuIChcbiAgICA8ZGl2IGNsYXNzPVwidGVzdC1jYXJkXCI+XG4gICAgICA8aDM+VGVzdCAxMDoge1wiPFNob3c+XCJ9IGNvbXBvbmVudDwvaDM+XG4gICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgc2hvd1NpZ25hbC52YWx1ZSA9IFwiSGVsbG8gZnJvbSBTaG93IVwiOyB9fT5cbiAgICAgICAgU2hvdyBjb250ZW50XG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBzaG93U2lnbmFsLnZhbHVlID0gbnVsbDsgfX0+SGlkZTwvYnV0dG9uPlxuICAgICAgPFNob3cgd2hlbj17c2hvd1NpZ25hbH0+XG4gICAgICAgIHsodmFsKSA9PiAoXG4gICAgICAgICAgPGRpdiBjbGFzcz1cIm1vY2stbW9kYWxcIj5cbiAgICAgICAgICAgIDxkaXYgY2xhc3M9XCJtb2NrLW1vZGFsLWNvbnRlbnRcIj5cbiAgICAgICAgICAgICAgPHN0cm9uZz57dmFsfTwvc3Ryb25nPlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICl9XG4gICAgICA8L1Nob3c+XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5cbiAgICAgICAge1wiPFNob3cgd2hlbj17c2lnbmFsfT5cIn0gcmVuZGVycyBjaGlsZHJlbiBvbmx5IHdoZW4gc2lnbmFsIGlzIHRydXRoeS5cbiAgICAgICAgTm8gcGFyZW50IHJlLXJlbmRlciBuZWVkZWQuXG4gICAgICA8L3A+XG4gICAgPC9kaXY+XG4gICk7XG59XG5cbi8vIOKUgOKUgOKUgCBUZXN0IDEwYjogU2hvdyBmb3IgbW9kYWwgcGF0dGVybiDilIDilIDilIBcbmNvbnN0IHNob3dNb2RhbEV2ZW50ID0gc2lnbmFsPHsgaWQ6IG51bWJlcjsgbmFtZTogc3RyaW5nIH0gfCBudWxsPihudWxsKTtcblxuZnVuY3Rpb24gVGVzdDEwYl9TaG93TW9kYWwoKSB7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgMTBiOiB7XCI8U2hvdz5cIn0gbW9kYWwgcGF0dGVybjwvaDM+XG4gICAgICA8ZGl2IGNsYXNzPVwiaXRlbS1saXN0XCI+XG4gICAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBzaG93TW9kYWxFdmVudC52YWx1ZSA9IHsgaWQ6IDEsIG5hbWU6IFwiQ2hhdG9yYVwiIH07IH19PlxuICAgICAgICAgIENoYXRvcmFcbiAgICAgICAgPC9idXR0b24+XG4gICAgICAgIDxidXR0b24gb25DbGljaz17KCkgPT4geyBzaG93TW9kYWxFdmVudC52YWx1ZSA9IHsgaWQ6IDIsIG5hbWU6IFwiTWlrZVwiIH07IH19PlxuICAgICAgICAgIE1pa2VcbiAgICAgICAgPC9idXR0b24+XG4gICAgICA8L2Rpdj5cbiAgICAgIDxTaG93IHdoZW49e3Nob3dNb2RhbEV2ZW50fT5cbiAgICAgICAgeyhldikgPT4gKFxuICAgICAgICAgIDxkaXYgY2xhc3M9XCJtb2NrLW1vZGFsXCI+XG4gICAgICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbC1jb250ZW50XCI+XG4gICAgICAgICAgICAgIDxzdHJvbmc+e2V2Lm5hbWV9PC9zdHJvbmc+IChpZD17ZXYuaWR9KVxuICAgICAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHsgc2hvd01vZGFsRXZlbnQudmFsdWUgPSBudWxsOyB9fT7DlzwvYnV0dG9uPlxuICAgICAgICAgICAgPC9kaXY+XG4gICAgICAgICAgPC9kaXY+XG4gICAgICAgICl9XG4gICAgICA8L1Nob3c+XG4gICAgICA8cCBjbGFzcz1cImhpbnRcIj5cbiAgICAgICAgVGhpcyBpcyB0aGUgaWRlYWwgbW9kYWwgcGF0dGVybiDigJQgbm8gdXNlU3RhdGUsIG5vIGJyaWRnZSwgbm8gcGFyZW50IHJlLXJlbmRlci5cbiAgICAgIDwvcD5cbiAgICA8L2Rpdj5cbiAgKTtcbn1cblxuLy8g4pSA4pSA4pSAIFRlc3QgMTE6IEZvciBjb21wb25lbnQgKGxpc3QgcmVuZGVyKSDilIDilIDilIBcbmNvbnN0IGxpc3RJdGVtcyA9IHNpZ25hbChbXG4gIHsgaWQ6IDEsIG5hbWU6IFwiQ2hhdG9yYVwiIH0sXG4gIHsgaWQ6IDIsIG5hbWU6IFwiTWlrZVwiIH0sXG4gIHsgaWQ6IDMsIG5hbWU6IFwiS2lqaXRvcmFcIiB9LFxuXSk7XG5cbmZ1bmN0aW9uIFRlc3QxMV9Gb3IoKSB7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgMTE6IHtcIjxGb3I+XCJ9IGNvbXBvbmVudDwvaDM+XG4gICAgICA8Rm9yIGVhY2g9e2xpc3RJdGVtc30+XG4gICAgICAgIHsoaXRlbSkgPT4gKFxuICAgICAgICAgIDxkaXYgc3R5bGU9XCJwYWRkaW5nOiA0cHggMDtcIj5cbiAgICAgICAgICAgICN7aXRlbS5pZH0g4oCUIDxzdHJvbmc+e2l0ZW0ubmFtZX08L3N0cm9uZz5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgKX1cbiAgICAgIDwvRm9yPlxuICAgICAgPGJ1dHRvblxuICAgICAgICBvbkNsaWNrPXsoKSA9PiB7XG4gICAgICAgICAgbGlzdEl0ZW1zLnZhbHVlID0gW1xuICAgICAgICAgICAgLi4ubGlzdEl0ZW1zLnZhbHVlLFxuICAgICAgICAgICAgeyBpZDogbGlzdEl0ZW1zLnZhbHVlLmxlbmd0aCArIDEsIG5hbWU6IGBQZXQgIyR7bGlzdEl0ZW1zLnZhbHVlLmxlbmd0aCArIDF9YCB9LFxuICAgICAgICAgIF07XG4gICAgICAgIH19XG4gICAgICA+XG4gICAgICAgIEFkZCBpdGVtXG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxidXR0b25cbiAgICAgICAgb25DbGljaz17KCkgPT4ge1xuICAgICAgICAgIGxpc3RJdGVtcy52YWx1ZSA9IGxpc3RJdGVtcy52YWx1ZS5zbGljZSgwLCAtMSk7XG4gICAgICAgIH19XG4gICAgICA+XG4gICAgICAgIFJlbW92ZSBsYXN0XG4gICAgICA8L2J1dHRvbj5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICB7XCI8Rm9yIGVhY2g9e3NpZ25hbH0+XCJ9IGVmZmljaWVudGx5IHJlbmRlcnMgbGlzdHMuIEl0ZW1zIHNob3VsZCBhZGQvcmVtb3ZlIHdpdGhvdXQgZnVsbCByZS1yZW5kZXIuXG4gICAgICA8L3A+XG4gICAgPC9kaXY+XG4gICk7XG59XG5cbi8vIOKUgOKUgOKUgCBUZXN0IDEyOiBTaG93ICsgdXNlTW9kZWwgKHByb2R1Y3Rpb24tcmVhZHkgcGF0dGVybikg4pSA4pSA4pSAXG5jb25zdCBGdWxsU3RvcmUgPSBjcmVhdGVNb2RlbCgoKSA9PiB7XG4gIGNvbnN0IHNlbGVjdGVkID0gc2lnbmFsPHsgaWQ6IG51bWJlcjsgbmFtZTogc3RyaW5nIH0gfCBudWxsPihudWxsKTtcbiAgY29uc3QgaXRlbXMgPSBzaWduYWwoW1xuICAgIHsgaWQ6IDEsIG5hbWU6IFwiQ2hhdG9yYSBzbGVlcGluZ1wiIH0sXG4gICAgeyBpZDogMiwgbmFtZTogXCJNaWtlIGVhdGluZ1wiIH0sXG4gICAgeyBpZDogMywgbmFtZTogXCJLaWppdG9yYSBwbGF5aW5nXCIgfSxcbiAgXSk7XG4gIGNvbnN0IG9wZW5Nb2RhbCA9IGFjdGlvbigoaXRlbTogeyBpZDogbnVtYmVyOyBuYW1lOiBzdHJpbmcgfSkgPT4ge1xuICAgIHNlbGVjdGVkLnZhbHVlID0gaXRlbTtcbiAgfSk7XG4gIGNvbnN0IGNsb3NlTW9kYWwgPSBhY3Rpb24oKCkgPT4ge1xuICAgIHNlbGVjdGVkLnZhbHVlID0gbnVsbDtcbiAgfSk7XG4gIHJldHVybiB7IHNlbGVjdGVkLCBpdGVtcywgb3Blbk1vZGFsLCBjbG9zZU1vZGFsIH07XG59KTtcblxuZnVuY3Rpb24gVGVzdDEyX0Z1bGxQYXR0ZXJuKCkge1xuICBjb25zdCBzdG9yZSA9IHVzZU1vZGVsKEZ1bGxTdG9yZSk7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtY2FyZFwiPlxuICAgICAgPGgzPlRlc3QgMTI6IHVzZU1vZGVsICsgU2hvdyArIEZvciAodGFyZ2V0IHBhdHRlcm4pPC9oMz5cbiAgICAgIDxGb3IgZWFjaD17c3RvcmUuaXRlbXN9PlxuICAgICAgICB7KGl0ZW0pID0+IChcbiAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9eygpID0+IHN0b3JlLm9wZW5Nb2RhbChpdGVtKX0+XG4gICAgICAgICAgICB7aXRlbS5uYW1lfVxuICAgICAgICAgIDwvYnV0dG9uPlxuICAgICAgICApfVxuICAgICAgPC9Gb3I+XG4gICAgICA8U2hvdyB3aGVuPXtzdG9yZS5zZWxlY3RlZH0+XG4gICAgICAgIHsoZXYpID0+IChcbiAgICAgICAgICA8ZGl2IGNsYXNzPVwibW9jay1tb2RhbFwiPlxuICAgICAgICAgICAgPGRpdiBjbGFzcz1cIm1vY2stbW9kYWwtY29udGVudFwiPlxuICAgICAgICAgICAgICA8c3Ryb25nPntldi5uYW1lfTwvc3Ryb25nPlxuICAgICAgICAgICAgICA8YnV0dG9uIG9uQ2xpY2s9e3N0b3JlLmNsb3NlTW9kYWx9PsOXPC9idXR0b24+XG4gICAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgICA8L2Rpdj5cbiAgICAgICAgKX1cbiAgICAgIDwvU2hvdz5cbiAgICAgIDxwIGNsYXNzPVwiaGludFwiPlxuICAgICAgICBUaGUgaWRlYWwgcHJvZHVjdGlvbiBwYXR0ZXJuOiBjcmVhdGVNb2RlbCArIHVzZU1vZGVsICsgU2hvdyArIEZvci5cbiAgICAgICAgTm8gdXNlU3RhdGUsIG5vIHVzZVNpZ25hbEVmZmVjdCBicmlkZ2UsIG5vIHBhcmVudCByZS1yZW5kZXJzLlxuICAgICAgPC9wPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG4vLyDilIDilIDilIAgQXBwIOKUgOKUgOKUgFxuZnVuY3Rpb24gU2lnbmFsc1Rlc3RBcHAoKSB7XG4gIHJldHVybiAoXG4gICAgPGRpdiBjbGFzcz1cInRlc3QtYXBwXCI+XG4gICAgICA8aDE+QHByZWFjdC9zaWduYWxzIFRlc3QgQmVuY2g8L2gxPlxuICAgICAgPHAgY2xhc3M9XCJzdWJ0aXRsZVwiPlxuICAgICAgICBWZXJpZnkgc2lnbmFsIHJlYWN0aXZpdHkgcGF0dGVybnMgYmVmb3JlIHByb2R1Y3Rpb24gdXNlLlxuICAgICAgICA8YnIgLz5cbiAgICAgICAgQnVpbGQ6IEJ1biB7dHlwZW9mIEJ1biAhPT0gXCJ1bmRlZmluZWRcIiA/IFwicnVudGltZVwiIDogXCJidW5kbGVkXCJ9IHxcbiAgICAgICAgQHByZWFjdC9zaWduYWxzIDIuOC4yXG4gICAgICA8L3A+XG4gICAgICA8ZGl2IGNsYXNzPVwidGVzdC1ncmlkXCI+XG4gICAgICAgIDxUZXN0MV9BdXRvU3Vic2NyaWJlIC8+XG4gICAgICAgIDxUZXN0Ml9CcmlkZ2UgLz5cbiAgICAgICAgPFRlc3QzX01vZGVsIC8+XG4gICAgICAgIDxUZXN0Nl9Vc2VTaWduYWwgLz5cbiAgICAgICAgPFRlc3Q3X1VzZUNvbXB1dGVkIC8+XG4gICAgICAgIDxUZXN0OF9CYXRjaCAvPlxuICAgICAgPC9kaXY+XG4gICAgICA8aDI+TW9kYWwgVGVzdHMgKHRoZSBicm9rZW4gY2FzZSk8L2gyPlxuICAgICAgPGRpdiBjbGFzcz1cInRlc3QtZ3JpZFwiPlxuICAgICAgICA8VGVzdDRfTW9kYWwgLz5cbiAgICAgICAgPFRlc3Q0Yl9Nb2RhbEJyaWRnZSAvPlxuICAgICAgICA8VGVzdDVfU3RvcmVNb2RhbCAvPlxuICAgICAgICA8VGVzdDViX1N0b3JlTW9kYWxCcmlkZ2UgLz5cbiAgICAgIDwvZGl2PlxuICAgICAgPGgyPlNob3cgLyBGb3IgKGRlY2xhcmF0aXZlIHBhdHRlcm4pPC9oMj5cbiAgICAgIDxkaXYgY2xhc3M9XCJ0ZXN0LWdyaWRcIj5cbiAgICAgICAgPFRlc3QxMF9TaG93IC8+XG4gICAgICAgIDxUZXN0MTBiX1Nob3dNb2RhbCAvPlxuICAgICAgICA8VGVzdDExX0ZvciAvPlxuICAgICAgICA8VGVzdDEyX0Z1bGxQYXR0ZXJuIC8+XG4gICAgICA8L2Rpdj5cbiAgICAgIDxoMj5EaWFnbm9zdGljczwvaDI+XG4gICAgICA8VGVzdDlfRGlhZ25vc3RpYyAvPlxuICAgIDwvZGl2PlxuICApO1xufVxuXG5jb25zdCByb290ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoXCJhcHBcIik7XG5pZiAoIXJvb3QpIHRocm93IG5ldyBFcnJvcihcIiNhcHAgcm9vdCBub3QgZm91bmRcIik7XG5yZW5kZXIoPFNpZ25hbHNUZXN0QXBwIC8+LCByb290KTtcbiIsCiAgICAiaW1wb3J0e29wdGlvbnMgYXMgbn1mcm9tXCJwcmVhY3RcIjt2YXIgdCxyLHUsaSxvPTAsZj1bXSxjPW4sZT1jLl9fYixhPWMuX19yLHY9Yy5kaWZmZWQsbD1jLl9fYyxtPWMudW5tb3VudCxzPWMuX187ZnVuY3Rpb24gcChuLHQpe2MuX19oJiZjLl9faChyLG4sb3x8dCksbz0wO3ZhciB1PXIuX19IfHwoci5fX0g9e19fOltdLF9faDpbXX0pO3JldHVybiBuPj11Ll9fLmxlbmd0aCYmdS5fXy5wdXNoKHt9KSx1Ll9fW25dfWZ1bmN0aW9uIGQobil7cmV0dXJuIG89MSxoKEQsbil9ZnVuY3Rpb24gaChuLHUsaSl7dmFyIG89cCh0KyssMik7aWYoby50PW4sIW8uX19jJiYoby5fXz1baT9pKHUpOkQodm9pZCAwLHUpLGZ1bmN0aW9uKG4pe3ZhciB0PW8uX19OP28uX19OWzBdOm8uX19bMF0scj1vLnQodCxuKTt0IT09ciYmKG8uX19OPVtyLG8uX19bMV1dLG8uX19jLnNldFN0YXRlKHt9KSl9XSxvLl9fYz1yLCFyLl9fZikpe3ZhciBmPWZ1bmN0aW9uKG4sdCxyKXtpZighby5fX2MuX19IKXJldHVybiEwO3ZhciB1PW8uX19jLl9fSC5fXy5maWx0ZXIoZnVuY3Rpb24obil7cmV0dXJuIG4uX19jfSk7aWYodS5ldmVyeShmdW5jdGlvbihuKXtyZXR1cm4hbi5fX059KSlyZXR1cm4hY3x8Yy5jYWxsKHRoaXMsbix0LHIpO3ZhciBpPW8uX19jLnByb3BzIT09bjtyZXR1cm4gdS5zb21lKGZ1bmN0aW9uKG4pe2lmKG4uX19OKXt2YXIgdD1uLl9fWzBdO24uX189bi5fX04sbi5fX049dm9pZCAwLHQhPT1uLl9fWzBdJiYoaT0hMCl9fSksYyYmYy5jYWxsKHRoaXMsbix0LHIpfHxpfTtyLl9fZj0hMDt2YXIgYz1yLnNob3VsZENvbXBvbmVudFVwZGF0ZSxlPXIuY29tcG9uZW50V2lsbFVwZGF0ZTtyLmNvbXBvbmVudFdpbGxVcGRhdGU9ZnVuY3Rpb24obix0LHIpe2lmKHRoaXMuX19lKXt2YXIgdT1jO2M9dm9pZCAwLGYobix0LHIpLGM9dX1lJiZlLmNhbGwodGhpcyxuLHQscil9LHIuc2hvdWxkQ29tcG9uZW50VXBkYXRlPWZ9cmV0dXJuIG8uX19OfHxvLl9ffWZ1bmN0aW9uIHkobix1KXt2YXIgaT1wKHQrKywzKTshYy5fX3MmJkMoaS5fX0gsdSkmJihpLl9fPW4saS51PXUsci5fX0guX19oLnB1c2goaSkpfWZ1bmN0aW9uIF8obix1KXt2YXIgaT1wKHQrKyw0KTshYy5fX3MmJkMoaS5fX0gsdSkmJihpLl9fPW4saS51PXUsci5fX2gucHVzaChpKSl9ZnVuY3Rpb24gQShuKXtyZXR1cm4gbz01LFQoZnVuY3Rpb24oKXtyZXR1cm57Y3VycmVudDpufX0sW10pfWZ1bmN0aW9uIEYobix0LHIpe289NixfKGZ1bmN0aW9uKCl7aWYoXCJmdW5jdGlvblwiPT10eXBlb2Ygbil7dmFyIHI9bih0KCkpO3JldHVybiBmdW5jdGlvbigpe24obnVsbCksciYmXCJmdW5jdGlvblwiPT10eXBlb2YgciYmcigpfX1pZihuKXJldHVybiBuLmN1cnJlbnQ9dCgpLGZ1bmN0aW9uKCl7cmV0dXJuIG4uY3VycmVudD1udWxsfX0sbnVsbD09cj9yOnIuY29uY2F0KG4pKX1mdW5jdGlvbiBUKG4scil7dmFyIHU9cCh0KyssNyk7cmV0dXJuIEModS5fX0gscikmJih1Ll9fPW4oKSx1Ll9fSD1yLHUuX19oPW4pLHUuX199ZnVuY3Rpb24gcShuLHQpe3JldHVybiBvPTgsVChmdW5jdGlvbigpe3JldHVybiBufSx0KX1mdW5jdGlvbiB4KG4pe3ZhciB1PXIuY29udGV4dFtuLl9fY10saT1wKHQrKyw5KTtyZXR1cm4gaS5jPW4sdT8obnVsbD09aS5fXyYmKGkuX189ITAsdS5zdWIocikpLHUucHJvcHMudmFsdWUpOm4uX199ZnVuY3Rpb24gUChuLHQpe2MudXNlRGVidWdWYWx1ZSYmYy51c2VEZWJ1Z1ZhbHVlKHQ/dChuKTpuKX1mdW5jdGlvbiBiKG4pe3ZhciB1PXAodCsrLDEwKSxpPWQoKTtyZXR1cm4gdS5fXz1uLHIuY29tcG9uZW50RGlkQ2F0Y2h8fChyLmNvbXBvbmVudERpZENhdGNoPWZ1bmN0aW9uKG4sdCl7dS5fXyYmdS5fXyhuLHQpLGlbMV0obil9KSxbaVswXSxmdW5jdGlvbigpe2lbMV0odm9pZCAwKX1dfWZ1bmN0aW9uIGcoKXt2YXIgbj1wKHQrKywxMSk7aWYoIW4uX18pe2Zvcih2YXIgdT1yLl9fdjtudWxsIT09dSYmIXUuX19tJiZudWxsIT09dS5fXzspdT11Ll9fO3ZhciBpPXUuX19tfHwodS5fX209WzAsMF0pO24uX189XCJQXCIraVswXStcIi1cIitpWzFdKyt9cmV0dXJuIG4uX199ZnVuY3Rpb24gaigpe2Zvcih2YXIgbjtuPWYuc2hpZnQoKTspe3ZhciB0PW4uX19IO2lmKG4uX19QJiZ0KXRyeXt0Ll9faC5zb21lKHopLHQuX19oLnNvbWUoQiksdC5fX2g9W119Y2F0Y2gocil7dC5fX2g9W10sYy5fX2UocixuLl9fdil9fX1jLl9fYj1mdW5jdGlvbihuKXtyPW51bGwsZSYmZShuKX0sYy5fXz1mdW5jdGlvbihuLHQpe24mJnQuX19rJiZ0Ll9fay5fX20mJihuLl9fbT10Ll9fay5fX20pLHMmJnMobix0KX0sYy5fX3I9ZnVuY3Rpb24obil7YSYmYShuKSx0PTA7dmFyIGk9KHI9bi5fX2MpLl9fSDtpJiYodT09PXI/KGkuX19oPVtdLHIuX19oPVtdLGkuX18uc29tZShmdW5jdGlvbihuKXtuLl9fTiYmKG4uX189bi5fX04pLG4udT1uLl9fTj12b2lkIDB9KSk6KGkuX19oLnNvbWUoeiksaS5fX2guc29tZShCKSxpLl9faD1bXSx0PTApKSx1PXJ9LGMuZGlmZmVkPWZ1bmN0aW9uKG4pe3YmJnYobik7dmFyIHQ9bi5fX2M7dCYmdC5fX0gmJih0Ll9fSC5fX2gubGVuZ3RoJiYoMSE9PWYucHVzaCh0KSYmaT09PWMucmVxdWVzdEFuaW1hdGlvbkZyYW1lfHwoKGk9Yy5yZXF1ZXN0QW5pbWF0aW9uRnJhbWUpfHx3KShqKSksdC5fX0guX18uc29tZShmdW5jdGlvbihuKXtuLnUmJihuLl9fSD1uLnUpLG4udT12b2lkIDB9KSksdT1yPW51bGx9LGMuX19jPWZ1bmN0aW9uKG4sdCl7dC5zb21lKGZ1bmN0aW9uKG4pe3RyeXtuLl9faC5zb21lKHopLG4uX19oPW4uX19oLmZpbHRlcihmdW5jdGlvbihuKXtyZXR1cm4hbi5fX3x8QihuKX0pfWNhdGNoKHIpe3Quc29tZShmdW5jdGlvbihuKXtuLl9faCYmKG4uX19oPVtdKX0pLHQ9W10sYy5fX2UocixuLl9fdil9fSksbCYmbChuLHQpfSxjLnVubW91bnQ9ZnVuY3Rpb24obil7bSYmbShuKTt2YXIgdCxyPW4uX19jO3ImJnIuX19IJiYoci5fX0guX18uc29tZShmdW5jdGlvbihuKXt0cnl7eihuKX1jYXRjaChuKXt0PW59fSksci5fX0g9dm9pZCAwLHQmJmMuX19lKHQsci5fX3YpKX07dmFyIGs9XCJmdW5jdGlvblwiPT10eXBlb2YgcmVxdWVzdEFuaW1hdGlvbkZyYW1lO2Z1bmN0aW9uIHcobil7dmFyIHQscj1mdW5jdGlvbigpe2NsZWFyVGltZW91dCh1KSxrJiZjYW5jZWxBbmltYXRpb25GcmFtZSh0KSxzZXRUaW1lb3V0KG4pfSx1PXNldFRpbWVvdXQociwzNSk7ayYmKHQ9cmVxdWVzdEFuaW1hdGlvbkZyYW1lKHIpKX1mdW5jdGlvbiB6KG4pe3ZhciB0PXIsdT1uLl9fYztcImZ1bmN0aW9uXCI9PXR5cGVvZiB1JiYobi5fX2M9dm9pZCAwLHUoKSkscj10fWZ1bmN0aW9uIEIobil7dmFyIHQ9cjtuLl9fYz1uLl9fKCkscj10fWZ1bmN0aW9uIEMobix0KXtyZXR1cm4hbnx8bi5sZW5ndGghPT10Lmxlbmd0aHx8dC5zb21lKGZ1bmN0aW9uKHQscil7cmV0dXJuIHQhPT1uW3JdfSl9ZnVuY3Rpb24gRChuLHQpe3JldHVyblwiZnVuY3Rpb25cIj09dHlwZW9mIHQ/dChuKTp0fWV4cG9ydHtxIGFzIHVzZUNhbGxiYWNrLHggYXMgdXNlQ29udGV4dCxQIGFzIHVzZURlYnVnVmFsdWUseSBhcyB1c2VFZmZlY3QsYiBhcyB1c2VFcnJvckJvdW5kYXJ5LGcgYXMgdXNlSWQsRiBhcyB1c2VJbXBlcmF0aXZlSGFuZGxlLF8gYXMgdXNlTGF5b3V0RWZmZWN0LFQgYXMgdXNlTWVtbyxoIGFzIHVzZVJlZHVjZXIsQSBhcyB1c2VSZWYsZCBhcyB1c2VTdGF0ZX07XG4vLyMgc291cmNlTWFwcGluZ1VSTD1ob29rcy5tb2R1bGUuanMubWFwXG4iLAogICAgImltcG9ydHtDb21wb25lbnQgYXMgaSxvcHRpb25zIGFzIG4saXNWYWxpZEVsZW1lbnQgYXMgcixGcmFnbWVudCBhcyB0fWZyb21cInByZWFjdFwiO2ltcG9ydHt1c2VNZW1vIGFzIG8sdXNlUmVmIGFzIGUsdXNlRWZmZWN0IGFzIGZ9ZnJvbVwicHJlYWN0L2hvb2tzXCI7aW1wb3J0e2VmZmVjdCBhcyB1LFNpZ25hbCBhcyBhLGNvbXB1dGVkIGFzIGMsc2lnbmFsIGFzIHYsYmF0Y2ggYXMgc31mcm9tXCJAcHJlYWN0L3NpZ25hbHMtY29yZVwiO2V4cG9ydHtTaWduYWwsYWN0aW9uLGJhdGNoLGNvbXB1dGVkLGNyZWF0ZU1vZGVsLGVmZmVjdCxzaWduYWwsdW50cmFja2VkfWZyb21cIkBwcmVhY3Qvc2lnbmFscy1jb3JlXCI7dmFyIGwsZCxoLHA9XCJ1bmRlZmluZWRcIiE9dHlwZW9mIHdpbmRvdyYmISF3aW5kb3cuX19QUkVBQ1RfU0lHTkFMU19ERVZUT09MU19fLG09W10sXz1bXTt1KGZ1bmN0aW9uKCl7bD10aGlzLk59KSgpO2Z1bmN0aW9uIGcoaSxyKXtuW2ldPXIuYmluZChudWxsLG5baV18fGZ1bmN0aW9uKCl7fSl9ZnVuY3Rpb24gYihpKXtpZihoKXt2YXIgbj1oO2g9dm9pZCAwO24oKX1oPWkmJmkuUygpfWZ1bmN0aW9uIHkoaSl7dmFyIG49dGhpcyx0PWkuZGF0YSxlPXVzZVNpZ25hbCh0KTtlLnZhbHVlPXQ7dmFyIGY9byhmdW5jdGlvbigpe3ZhciBpPW4sdD1uLl9fdjt3aGlsZSh0PXQuX18paWYodC5fX2Mpe3QuX19jLl9fJGZ8PTQ7YnJlYWt9dmFyIG89YyhmdW5jdGlvbigpe3ZhciBpPWUudmFsdWUudmFsdWU7cmV0dXJuIDA9PT1pPzA6ITA9PT1pP1wiXCI6aXx8XCJcIn0pLGY9YyhmdW5jdGlvbigpe3JldHVybiFBcnJheS5pc0FycmF5KG8udmFsdWUpJiYhcihvLnZhbHVlKX0pLGE9dShmdW5jdGlvbigpe3RoaXMuTj1GO2lmKGYudmFsdWUpe3ZhciBuPW8udmFsdWU7aWYoaS5fX3YmJmkuX192Ll9fZSYmMz09PWkuX192Ll9fZS5ub2RlVHlwZSlpLl9fdi5fX2UuZGF0YT1ufX0pLHY9bi5fXyR1LmQ7bi5fXyR1LmQ9ZnVuY3Rpb24oKXthKCk7di5jYWxsKHRoaXMpfTtyZXR1cm5bZixvXX0sW10pLGE9ZlswXSx2PWZbMV07cmV0dXJuIGEudmFsdWU/di5wZWVrKCk6di52YWx1ZX15LmRpc3BsYXlOYW1lPVwiUmVhY3RpdmVUZXh0Tm9kZVwiO09iamVjdC5kZWZpbmVQcm9wZXJ0aWVzKGEucHJvdG90eXBlLHtjb25zdHJ1Y3Rvcjp7Y29uZmlndXJhYmxlOiEwLHZhbHVlOnZvaWQgMH0sdHlwZTp7Y29uZmlndXJhYmxlOiEwLHZhbHVlOnl9LHByb3BzOntjb25maWd1cmFibGU6ITAsZ2V0OmZ1bmN0aW9uKCl7dmFyIGk9dGhpcztyZXR1cm57ZGF0YTp7Z2V0IHZhbHVlKCl7cmV0dXJuIGkudmFsdWV9fX19fSxfX2I6e2NvbmZpZ3VyYWJsZTohMCx2YWx1ZToxfX0pO2coXCJfX2JcIixmdW5jdGlvbihpLG4pe2lmKFwic3RyaW5nXCI9PXR5cGVvZiBuLnR5cGUpe3ZhciByLHQ9bi5wcm9wcztmb3IodmFyIG8gaW4gdClpZihcImNoaWxkcmVuXCIhPT1vKXt2YXIgZT10W29dO2lmKGUgaW5zdGFuY2VvZiBhKXtpZighciluLl9fbnA9cj17fTtyW29dPWU7dFtvXT1lLnBlZWsoKX19fWkobil9KTtnKFwiX19yXCIsZnVuY3Rpb24oaSxuKXtpKG4pO2lmKG4udHlwZSE9PXQpe2IoKTt2YXIgcixvPW4uX19jO2lmKG8pe28uX18kZiY9LTI7aWYodm9pZCAwPT09KHI9by5fXyR1KSlvLl9fJHU9cj1mdW5jdGlvbihpLG4pe3ZhciByO3UoZnVuY3Rpb24oKXtyPXRoaXN9LHtuYW1lOm59KTtyLmM9aTtyZXR1cm4gcn0oZnVuY3Rpb24oKXt2YXIgaTtpZihwKW51bGw9PShpPXIueSl8fGkuY2FsbChyKTtvLl9fJGZ8PTE7by5zZXRTdGF0ZSh7fSl9LFwiZnVuY3Rpb25cIj09dHlwZW9mIG4udHlwZT9uLnR5cGUuZGlzcGxheU5hbWV8fG4udHlwZS5uYW1lOlwiXCIpfWQ9bztiKHIpfX0pO2coXCJfX2VcIixmdW5jdGlvbihpLG4scix0KXtiKCk7ZD12b2lkIDA7aShuLHIsdCl9KTtnKFwiZGlmZmVkXCIsZnVuY3Rpb24oaSxuKXtiKCk7ZD12b2lkIDA7dmFyIHI7aWYoXCJzdHJpbmdcIj09dHlwZW9mIG4udHlwZSYmKHI9bi5fX2UpKXt2YXIgdD1uLl9fbnAsbz1uLnByb3BzO2lmKHQpe3ZhciBlPXIuVTtpZihlKWZvcih2YXIgZiBpbiBlKXt2YXIgdT1lW2ZdO2lmKHZvaWQgMCE9PXUmJiEoZiBpbiB0KSl7dS5kKCk7ZVtmXT12b2lkIDB9fWVsc2V7ZT17fTtyLlU9ZX1mb3IodmFyIGEgaW4gdCl7dmFyIGM9ZVthXSx2PXRbYV07aWYodm9pZCAwPT09Yyl7Yz13KHIsYSx2KTtlW2FdPWN9ZWxzZSBjLm8odixvKX1mb3IodmFyIHMgaW4gdClvW3NdPXRbc119fWkobil9KTtmdW5jdGlvbiB3KGksbixyLHQpe3ZhciBvPW4gaW4gaSYmdm9pZCAwPT09aS5vd25lclNWR0VsZW1lbnQsZT12KHIpLGY9ci5wZWVrKCk7cmV0dXJue286ZnVuY3Rpb24oaSxuKXtlLnZhbHVlPWk7Zj1pLnBlZWsoKX0sZDp1KGZ1bmN0aW9uKCl7dGhpcy5OPUY7dmFyIHI9ZS52YWx1ZS52YWx1ZTtpZihmIT09cil7Zj12b2lkIDA7aWYobylpW25dPXI7ZWxzZSBpZihudWxsIT1yJiYoITEhPT1yfHxcIi1cIj09PW5bNF0pKWkuc2V0QXR0cmlidXRlKG4scik7ZWxzZSBpLnJlbW92ZUF0dHJpYnV0ZShuKX1lbHNlIGY9dm9pZCAwfSl9fWcoXCJ1bm1vdW50XCIsZnVuY3Rpb24oaSxuKXtpZihcInN0cmluZ1wiPT10eXBlb2Ygbi50eXBlKXt2YXIgcj1uLl9fZTtpZihyKXt2YXIgdD1yLlU7aWYodCl7ci5VPXZvaWQgMDtmb3IodmFyIG8gaW4gdCl7dmFyIGU9dFtvXTtpZihlKWUuZCgpfX19bi5fX25wPXZvaWQgMH1lbHNle3ZhciBmPW4uX19jO2lmKGYpe3ZhciB1PWYuX18kdTtpZih1KXtmLl9fJHU9dm9pZCAwO3UuZCgpfX19aShuKX0pO2coXCJfX2hcIixmdW5jdGlvbihpLG4scix0KXtpZih0PDN8fDk9PT10KW4uX18kZnw9MjtpKG4scix0KX0pO2kucHJvdG90eXBlLnNob3VsZENvbXBvbmVudFVwZGF0ZT1mdW5jdGlvbihpLG4pe2lmKHRoaXMuX19SKXJldHVybiEwO3ZhciByPXRoaXMuX18kdSx0PXImJnZvaWQgMCE9PXIucztmb3IodmFyIG8gaW4gbilyZXR1cm4hMDtpZih0aGlzLl9fZnx8XCJib29sZWFuXCI9PXR5cGVvZiB0aGlzLnUmJiEwPT09dGhpcy51KXt2YXIgZT0yJnRoaXMuX18kZjtpZighKHR8fGV8fDQmdGhpcy5fXyRmKSlyZXR1cm4hMDtpZigxJnRoaXMuX18kZilyZXR1cm4hMH1lbHNle2lmKCEodHx8NCZ0aGlzLl9fJGYpKXJldHVybiEwO2lmKDMmdGhpcy5fXyRmKXJldHVybiEwfWZvcih2YXIgZiBpbiBpKWlmKFwiX19zb3VyY2VcIiE9PWYmJmlbZl0hPT10aGlzLnByb3BzW2ZdKXJldHVybiEwO2Zvcih2YXIgdSBpbiB0aGlzLnByb3BzKWlmKCEodSBpbiBpKSlyZXR1cm4hMDtyZXR1cm4hMX07ZnVuY3Rpb24gdXNlU2lnbmFsKGksbil7cmV0dXJuIG8oZnVuY3Rpb24oKXtyZXR1cm4gdihpLG4pfSxbXSl9ZnVuY3Rpb24gdXNlQ29tcHV0ZWQoaSxuKXt2YXIgcj1lKGkpO3IuY3VycmVudD1pO2QuX18kZnw9NDtyZXR1cm4gbyhmdW5jdGlvbigpe3JldHVybiBjKGZ1bmN0aW9uKCl7cmV0dXJuIHIuY3VycmVudCgpfSxuKX0sW10pfXZhciBrPVwidW5kZWZpbmVkXCI9PXR5cGVvZiByZXF1ZXN0QW5pbWF0aW9uRnJhbWU/c2V0VGltZW91dDpmdW5jdGlvbihpKXt2YXIgbj1mdW5jdGlvbigpe2NsZWFyVGltZW91dChyKTtjYW5jZWxBbmltYXRpb25GcmFtZSh0KTtpKCl9LHI9c2V0VGltZW91dChuLDM1KSx0PXJlcXVlc3RBbmltYXRpb25GcmFtZShuKX0scT1mdW5jdGlvbihpKXtxdWV1ZU1pY3JvdGFzayhmdW5jdGlvbigpe3F1ZXVlTWljcm90YXNrKGkpfSl9O2Z1bmN0aW9uIEEoKXtzKGZ1bmN0aW9uKCl7dmFyIGk7d2hpbGUoaT1tLnNoaWZ0KCkpbC5jYWxsKGkpfSl9ZnVuY3Rpb24gVCgpe2lmKDE9PT1tLnB1c2godGhpcykpKG4ucmVxdWVzdEFuaW1hdGlvbkZyYW1lfHxrKShBKX1mdW5jdGlvbiB4KCl7cyhmdW5jdGlvbigpe3ZhciBpO3doaWxlKGk9Xy5zaGlmdCgpKWwuY2FsbChpKX0pfWZ1bmN0aW9uIEYoKXtpZigxPT09Xy5wdXNoKHRoaXMpKShuLnJlcXVlc3RBbmltYXRpb25GcmFtZXx8cSkoeCl9ZnVuY3Rpb24gdXNlU2lnbmFsRWZmZWN0KGksbil7dmFyIHI9ZShpKTtyLmN1cnJlbnQ9aTtmKGZ1bmN0aW9uKCl7cmV0dXJuIHUoZnVuY3Rpb24oKXt0aGlzLk49VDtyZXR1cm4gci5jdXJyZW50KCl9LG4pfSxbXSl9ZnVuY3Rpb24gTShpKXt2YXIgbj1vKGZ1bmN0aW9uKCl7cmV0dXJuIGkoKX0sW10pO2YoZnVuY3Rpb24oKXtyZXR1cm4gbltTeW1ib2wuZGlzcG9zZV19LFtuXSk7cmV0dXJuIG59ZXhwb3J0e3VzZUNvbXB1dGVkLE0gYXMgdXNlTW9kZWwsdXNlU2lnbmFsLHVzZVNpZ25hbEVmZmVjdH07Ly8jIHNvdXJjZU1hcHBpbmdVUkw9c2lnbmFscy5tb2R1bGUuanMubWFwXG4iLAogICAgInZhciBpPVN5bWJvbC5mb3IoXCJwcmVhY3Qtc2lnbmFsc1wiKTtmdW5jdGlvbiB0KCl7aWYoIShzPjEpKXt2YXIgaSx0PSExOyFmdW5jdGlvbigpe3ZhciBpPWQ7ZD12b2lkIDA7d2hpbGUodm9pZCAwIT09aSl7aWYoaS5TLnY9PT1pLnYpaS5TLmk9aS5pO2k9aS5vfX0oKTt3aGlsZSh2b2lkIDAhPT1oKXt2YXIgbj1oO2g9dm9pZCAwO3YrKzt3aGlsZSh2b2lkIDAhPT1uKXt2YXIgcj1uLnU7bi51PXZvaWQgMDtuLmYmPS0zO2lmKCEoOCZuLmYpJiZ3KG4pKXRyeXtuLmMoKX1jYXRjaChuKXtpZighdCl7aT1uO3Q9ITB9fW49cn19dj0wO3MtLTtpZih0KXRocm93IGl9ZWxzZSBzLS19ZnVuY3Rpb24gbihpKXtpZihzPjApcmV0dXJuIGkoKTtlPSsrdTtzKys7dHJ5e3JldHVybiBpKCl9ZmluYWxseXt0KCl9fXZhciByPXZvaWQgMDtmdW5jdGlvbiBvKGkpe3ZhciB0PXI7cj12b2lkIDA7dHJ5e3JldHVybiBpKCl9ZmluYWxseXtyPXR9fXZhciBmLGg9dm9pZCAwLHM9MCx2PTAsdT0wLGU9MCxkPXZvaWQgMCxjPTA7ZnVuY3Rpb24gYShpKXtpZih2b2lkIDAhPT1yKXt2YXIgdD1pLm47aWYodm9pZCAwPT09dHx8dC50IT09cil7dD17aTowLFM6aSxwOnIucyxuOnZvaWQgMCx0OnIsZTp2b2lkIDAseDp2b2lkIDAscjp0fTtpZih2b2lkIDAhPT1yLnMpci5zLm49dDtyLnM9dDtpLm49dDtpZigzMiZyLmYpaS5TKHQpO3JldHVybiB0fWVsc2UgaWYoLTE9PT10Lmkpe3QuaT0wO2lmKHZvaWQgMCE9PXQubil7dC5uLnA9dC5wO2lmKHZvaWQgMCE9PXQucCl0LnAubj10Lm47dC5wPXIuczt0Lm49dm9pZCAwO3Iucy5uPXQ7ci5zPXR9cmV0dXJuIHR9fX1mdW5jdGlvbiBsKGksdCl7dGhpcy52PWk7dGhpcy5pPTA7dGhpcy5uPXZvaWQgMDt0aGlzLnQ9dm9pZCAwO3RoaXMubD0wO3RoaXMuVz1udWxsPT10P3ZvaWQgMDp0LndhdGNoZWQ7dGhpcy5aPW51bGw9PXQ/dm9pZCAwOnQudW53YXRjaGVkO3RoaXMubmFtZT1udWxsPT10P3ZvaWQgMDp0Lm5hbWV9bC5wcm90b3R5cGUuYnJhbmQ9aTtsLnByb3RvdHlwZS5oPWZ1bmN0aW9uKCl7cmV0dXJuITB9O2wucHJvdG90eXBlLlM9ZnVuY3Rpb24oaSl7dmFyIHQ9dGhpcyxuPXRoaXMudDtpZihuIT09aSYmdm9pZCAwPT09aS5lKXtpLng9bjt0aGlzLnQ9aTtpZih2b2lkIDAhPT1uKW4uZT1pO2Vsc2UgbyhmdW5jdGlvbigpe3ZhciBpO251bGw9PShpPXQuVyl8fGkuY2FsbCh0KX0pfX07bC5wcm90b3R5cGUuVT1mdW5jdGlvbihpKXt2YXIgdD10aGlzO2lmKHZvaWQgMCE9PXRoaXMudCl7dmFyIG49aS5lLHI9aS54O2lmKHZvaWQgMCE9PW4pe24ueD1yO2kuZT12b2lkIDB9aWYodm9pZCAwIT09cil7ci5lPW47aS54PXZvaWQgMH1pZihpPT09dGhpcy50KXt0aGlzLnQ9cjtpZih2b2lkIDA9PT1yKW8oZnVuY3Rpb24oKXt2YXIgaTtudWxsPT0oaT10LlopfHxpLmNhbGwodCl9KX19fTtsLnByb3RvdHlwZS5zdWJzY3JpYmU9ZnVuY3Rpb24oaSl7dmFyIHQ9dGhpcztyZXR1cm4gQyhmdW5jdGlvbigpe3ZhciBuPXQudmFsdWUsbz1yO3I9dm9pZCAwO3RyeXtpKG4pfWZpbmFsbHl7cj1vfX0se25hbWU6XCJzdWJcIn0pfTtsLnByb3RvdHlwZS52YWx1ZU9mPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudmFsdWV9O2wucHJvdG90eXBlLnRvU3RyaW5nPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudmFsdWUrXCJcIn07bC5wcm90b3R5cGUudG9KU09OPWZ1bmN0aW9uKCl7cmV0dXJuIHRoaXMudmFsdWV9O2wucHJvdG90eXBlLnBlZWs9ZnVuY3Rpb24oKXt2YXIgaT1yO3I9dm9pZCAwO3RyeXtyZXR1cm4gdGhpcy52YWx1ZX1maW5hbGx5e3I9aX19O09iamVjdC5kZWZpbmVQcm9wZXJ0eShsLnByb3RvdHlwZSxcInZhbHVlXCIse2dldDpmdW5jdGlvbigpe3ZhciBpPWEodGhpcyk7aWYodm9pZCAwIT09aSlpLmk9dGhpcy5pO3JldHVybiB0aGlzLnZ9LHNldDpmdW5jdGlvbihpKXtpZihpIT09dGhpcy52KXtpZih2PjEwMCl0aHJvdyBuZXcgRXJyb3IoXCJDeWNsZSBkZXRlY3RlZFwiKTshZnVuY3Rpb24oaSl7aWYoMCE9PXMmJjA9PT12KWlmKGkubCE9PWUpe2kubD1lO2Q9e1M6aSx2OmkudixpOmkuaSxvOmR9fX0odGhpcyk7dGhpcy52PWk7dGhpcy5pKys7YysrO3MrKzt0cnl7Zm9yKHZhciBuPXRoaXMudDt2b2lkIDAhPT1uO249bi54KW4udC5OKCl9ZmluYWxseXt0KCl9fX19KTtmdW5jdGlvbiB5KGksdCl7cmV0dXJuIG5ldyBsKGksdCl9ZnVuY3Rpb24gdyhpKXtmb3IodmFyIHQ9aS5zO3ZvaWQgMCE9PXQ7dD10Lm4paWYodC5TLmkhPT10Lml8fCF0LlMuaCgpfHx0LlMuaSE9PXQuaSlyZXR1cm4hMDtyZXR1cm4hMX1mdW5jdGlvbiBfKGkpe2Zvcih2YXIgdD1pLnM7dm9pZCAwIT09dDt0PXQubil7dmFyIG49dC5TLm47aWYodm9pZCAwIT09bil0LnI9bjt0LlMubj10O3QuaT0tMTtpZih2b2lkIDA9PT10Lm4pe2kucz10O2JyZWFrfX19ZnVuY3Rpb24gYihpKXt2YXIgdD1pLnMsbj12b2lkIDA7d2hpbGUodm9pZCAwIT09dCl7dmFyIHI9dC5wO2lmKC0xPT09dC5pKXt0LlMuVSh0KTtpZih2b2lkIDAhPT1yKXIubj10Lm47aWYodm9pZCAwIT09dC5uKXQubi5wPXJ9ZWxzZSBuPXQ7dC5TLm49dC5yO2lmKHZvaWQgMCE9PXQucil0LnI9dm9pZCAwO3Q9cn1pLnM9bn1mdW5jdGlvbiBwKGksdCl7bC5jYWxsKHRoaXMsdm9pZCAwKTt0aGlzLng9aTt0aGlzLnM9dm9pZCAwO3RoaXMuZz1jLTE7dGhpcy5mPTQ7dGhpcy5XPW51bGw9PXQ/dm9pZCAwOnQud2F0Y2hlZDt0aGlzLlo9bnVsbD09dD92b2lkIDA6dC51bndhdGNoZWQ7dGhpcy5uYW1lPW51bGw9PXQ/dm9pZCAwOnQubmFtZX1wLnByb3RvdHlwZT1uZXcgbDtwLnByb3RvdHlwZS5oPWZ1bmN0aW9uKCl7dGhpcy5mJj0tMztpZigxJnRoaXMuZilyZXR1cm4hMTtpZigzMj09KDM2JnRoaXMuZikpcmV0dXJuITA7dGhpcy5mJj0tNTtpZih0aGlzLmc9PT1jKXJldHVybiEwO3RoaXMuZz1jO3RoaXMuZnw9MTtpZih0aGlzLmk+MCYmIXcodGhpcykpe3RoaXMuZiY9LTI7cmV0dXJuITB9dmFyIGk9cjt0cnl7Xyh0aGlzKTtyPXRoaXM7dmFyIHQ9dGhpcy54KCk7aWYoMTYmdGhpcy5mfHx0aGlzLnYhPT10fHwwPT09dGhpcy5pKXt0aGlzLnY9dDt0aGlzLmYmPS0xNzt0aGlzLmkrK319Y2F0Y2goaSl7dGhpcy52PWk7dGhpcy5mfD0xNjt0aGlzLmkrK31yPWk7Yih0aGlzKTt0aGlzLmYmPS0yO3JldHVybiEwfTtwLnByb3RvdHlwZS5TPWZ1bmN0aW9uKGkpe2lmKHZvaWQgMD09PXRoaXMudCl7dGhpcy5mfD0zNjtmb3IodmFyIHQ9dGhpcy5zO3ZvaWQgMCE9PXQ7dD10Lm4pdC5TLlModCl9bC5wcm90b3R5cGUuUy5jYWxsKHRoaXMsaSl9O3AucHJvdG90eXBlLlU9ZnVuY3Rpb24oaSl7aWYodm9pZCAwIT09dGhpcy50KXtsLnByb3RvdHlwZS5VLmNhbGwodGhpcyxpKTtpZih2b2lkIDA9PT10aGlzLnQpe3RoaXMuZiY9LTMzO2Zvcih2YXIgdD10aGlzLnM7dm9pZCAwIT09dDt0PXQubil0LlMuVSh0KX19fTtwLnByb3RvdHlwZS5OPWZ1bmN0aW9uKCl7aWYoISgyJnRoaXMuZikpe3RoaXMuZnw9Njtmb3IodmFyIGk9dGhpcy50O3ZvaWQgMCE9PWk7aT1pLngpaS50Lk4oKX19O09iamVjdC5kZWZpbmVQcm9wZXJ0eShwLnByb3RvdHlwZSxcInZhbHVlXCIse2dldDpmdW5jdGlvbigpe2lmKDEmdGhpcy5mKXRocm93IG5ldyBFcnJvcihcIkN5Y2xlIGRldGVjdGVkXCIpO3ZhciBpPWEodGhpcyk7dGhpcy5oKCk7aWYodm9pZCAwIT09aSlpLmk9dGhpcy5pO2lmKDE2JnRoaXMuZil0aHJvdyB0aGlzLnY7cmV0dXJuIHRoaXMudn19KTtmdW5jdGlvbiBnKGksdCl7cmV0dXJuIG5ldyBwKGksdCl9ZnVuY3Rpb24gUyhpKXt2YXIgbj1pLm07aS5tPXZvaWQgMDtpZihcImZ1bmN0aW9uXCI9PXR5cGVvZiBuKXtzKys7dmFyIG89cjtyPXZvaWQgMDt0cnl7bigpfWNhdGNoKHQpe2kuZiY9LTI7aS5mfD04O20oaSk7dGhyb3cgdH1maW5hbGx5e3I9bzt0KCl9fX1mdW5jdGlvbiBtKGkpe2Zvcih2YXIgdD1pLnM7dm9pZCAwIT09dDt0PXQubil0LlMuVSh0KTtpLng9dm9pZCAwO2kucz12b2lkIDA7UyhpKX1mdW5jdGlvbiB4KGkpe2lmKHIhPT10aGlzKXRocm93IG5ldyBFcnJvcihcIk91dC1vZi1vcmRlciBlZmZlY3RcIik7Yih0aGlzKTtyPWk7dGhpcy5mJj0tMjtpZig4JnRoaXMuZiltKHRoaXMpO3QoKX1mdW5jdGlvbiBFKGksdCl7dGhpcy54PWk7dGhpcy5tPXZvaWQgMDt0aGlzLnM9dm9pZCAwO3RoaXMudT12b2lkIDA7dGhpcy5mPTMyO3RoaXMubmFtZT1udWxsPT10P3ZvaWQgMDp0Lm5hbWU7aWYoZilmLnB1c2godGhpcyl9RS5wcm90b3R5cGUuYz1mdW5jdGlvbigpe3ZhciBpPXRoaXMuUygpO3RyeXtpZig4JnRoaXMuZilyZXR1cm47aWYodm9pZCAwPT09dGhpcy54KXJldHVybjt2YXIgdD10aGlzLngoKTtpZihcImZ1bmN0aW9uXCI9PXR5cGVvZiB0KXRoaXMubT10fWZpbmFsbHl7aSgpfX07RS5wcm90b3R5cGUuUz1mdW5jdGlvbigpe2lmKDEmdGhpcy5mKXRocm93IG5ldyBFcnJvcihcIkN5Y2xlIGRldGVjdGVkXCIpO3RoaXMuZnw9MTt0aGlzLmYmPS05O1ModGhpcyk7Xyh0aGlzKTtzKys7dmFyIGk9cjtyPXRoaXM7cmV0dXJuIHguYmluZCh0aGlzLGkpfTtFLnByb3RvdHlwZS5OPWZ1bmN0aW9uKCl7aWYoISgyJnRoaXMuZikpe3RoaXMuZnw9Mjt0aGlzLnU9aDtoPXRoaXN9fTtFLnByb3RvdHlwZS5kPWZ1bmN0aW9uKCl7dGhpcy5mfD04O2lmKCEoMSZ0aGlzLmYpKW0odGhpcyl9O0UucHJvdG90eXBlLmRpc3Bvc2U9ZnVuY3Rpb24oKXt0aGlzLmQoKX07ZnVuY3Rpb24gQyhpLHQpe3ZhciBuPW5ldyBFKGksdCk7dHJ5e24uYygpfWNhdGNoKGkpe24uZCgpO3Rocm93IGl9dmFyIHI9bi5kLmJpbmQobik7cltTeW1ib2wuZGlzcG9zZV09cjtyZXR1cm4gcn1mdW5jdGlvbiBPKGkpe3JldHVybiBmdW5jdGlvbigpe3ZhciB0PWFyZ3VtZW50cyxyPXRoaXM7cmV0dXJuIG4oZnVuY3Rpb24oKXtyZXR1cm4gbyhmdW5jdGlvbigpe3JldHVybiBpLmFwcGx5KHIsW10uc2xpY2UuY2FsbCh0KSl9KX0pfX1mdW5jdGlvbiBqKCl7dmFyIGk9ZjtmPVtdO3JldHVybiBmdW5jdGlvbigpe3ZhciB0PWY7aWYoZiYmaSlpPWkuY29uY2F0KGYpO2Y9aTtyZXR1cm4gdH19ZnVuY3Rpb24gayhpKXtyZXR1cm4gZnVuY3Rpb24oKXt2YXIgdCxuLHI9aigpO3RyeXtuPWkuYXBwbHkodm9pZCAwLFtdLnNsaWNlLmNhbGwoYXJndW1lbnRzKSl9Y2F0Y2goaSl7Zj12b2lkIDA7dGhyb3cgaX1maW5hbGx5e3Q9cigpfWZvcih2YXIgbyBpbiBuKWlmKFwiZnVuY3Rpb25cIj09dHlwZW9mIG5bb10pbltvXT1PKG5bb10pO25bU3ltYm9sLmRpc3Bvc2VdPU8oZnVuY3Rpb24oKXtpZih0KWZvcih2YXIgaT0wO2k8dC5sZW5ndGg7aSsrKXRbaV0uZGlzcG9zZSgpO3Q9dm9pZCAwfSk7cmV0dXJuIG59fWV4cG9ydHtwIGFzIENvbXB1dGVkLEUgYXMgRWZmZWN0LGwgYXMgU2lnbmFsLE8gYXMgYWN0aW9uLG4gYXMgYmF0Y2gsZyBhcyBjb21wdXRlZCxrIGFzIGNyZWF0ZU1vZGVsLEMgYXMgZWZmZWN0LHkgYXMgc2lnbmFsLG8gYXMgdW50cmFja2VkfTsvLyMgc291cmNlTWFwcGluZ1VSTD1zaWduYWxzLWNvcmUubW9kdWxlLmpzLm1hcFxuIiwKICAgICJpbXBvcnR7U2lnbmFsIGFzIG59ZnJvbVwiQHByZWFjdC9zaWduYWxzLWNvcmVcIjtpbXBvcnR7dXNlU2lnbmFsfWZyb21cIkBwcmVhY3Qvc2lnbmFsc1wiO2ltcG9ydHtjcmVhdGVFbGVtZW50IGFzIHIsRnJhZ21lbnQgYXMgdH1mcm9tXCJwcmVhY3RcIjtpbXBvcnR7dXNlTWVtbyBhcyBlfWZyb21cInByZWFjdC9ob29rc1wiO3ZhciBpPWZ1bmN0aW9uKG4pe3JldHVyblwiZnVuY3Rpb25cIj09dHlwZW9mIG4uY2hpbGRyZW4/bi5jaGlsZHJlbihuLnYsbi5pKTpuLmNoaWxkcmVufTtpLmRpc3BsYXlOYW1lPVwiSXRlbVwiO2Z1bmN0aW9uIG8obil7dmFyIHQ9XCJmdW5jdGlvblwiPT10eXBlb2Ygbi53aGVuP24ud2hlbigpOm4ud2hlbi52YWx1ZTtpZighdClyZXR1cm4gbi5mYWxsYmFja3x8bnVsbDtlbHNlIHJldHVybiByKGkse3Y6dCxjaGlsZHJlbjpuLmNoaWxkcmVufSl9by5kaXNwbGF5TmFtZT1cIlNob3dcIjtmdW5jdGlvbiB1KG8pe3ZhciB1PWUoZnVuY3Rpb24oKXtyZXR1cm4gbmV3IE1hcH0sW10pLGY9XCJmdW5jdGlvblwiPT10eXBlb2Ygby5lYWNoP28uZWFjaCgpOm8uZWFjaCxjPWYgaW5zdGFuY2VvZiBuP2YudmFsdWU6ZjtpZighYy5sZW5ndGgpcmV0dXJuIG8uZmFsbGJhY2t8fG51bGw7dmFyIGE9bmV3IFNldCh1LmtleXMoKSkscD1jLm1hcChmdW5jdGlvbihuLHQpe2EuZGVsZXRlKG4pO2lmKCF1LmhhcyhuKSl7dmFyIGU9cihpLHt2Om4saTp0LGNoaWxkcmVuOm8uY2hpbGRyZW59KTt1LnNldChuLGUpO3JldHVybiBlfXJldHVybiB1LmdldChuKX0pO2EuZm9yRWFjaChmdW5jdGlvbihuKXt1LmRlbGV0ZShuKX0pO3JldHVybiByKHQsbnVsbCxwKX11LmRpc3BsYXlOYW1lPVwiRm9yXCI7ZnVuY3Rpb24gZihuKXt2YXIgcj11c2VTaWduYWwobik7aWYoci5wZWVrKCkhPT1uKXIudmFsdWU9bjtyZXR1cm4gcn1mdW5jdGlvbiBjKG4pe3ZhciByPXVzZVNpZ25hbChuKTtpZighKFwiY3VycmVudFwiaW4gcikpT2JqZWN0LmRlZmluZVByb3BlcnR5KHIsXCJjdXJyZW50XCIsYSk7cmV0dXJuIHJ9dmFyIGE9e2NvbmZpZ3VyYWJsZTohMCxnZXQ6ZnVuY3Rpb24oKXtyZXR1cm4gdGhpcy52YWx1ZX0sc2V0OmZ1bmN0aW9uKG4pe3RoaXMudmFsdWU9bn19O2V4cG9ydHt1IGFzIEZvcixvIGFzIFNob3csZiBhcyB1c2VMaXZlU2lnbmFsLGMgYXMgdXNlU2lnbmFsUmVmfTsvLyMgc291cmNlTWFwcGluZ1VSTD11dGlscy5tb2R1bGUuanMubWFwXG4iLAogICAgImltcG9ydHtvcHRpb25zIGFzIHIsRnJhZ21lbnQgYXMgZX1mcm9tXCJwcmVhY3RcIjtleHBvcnR7RnJhZ21lbnR9ZnJvbVwicHJlYWN0XCI7dmFyIHQ9L1tcIiY8XS87ZnVuY3Rpb24gbihyKXtpZigwPT09ci5sZW5ndGh8fCExPT09dC50ZXN0KHIpKXJldHVybiByO2Zvcih2YXIgZT0wLG49MCxvPVwiXCIsZj1cIlwiO248ci5sZW5ndGg7bisrKXtzd2l0Y2goci5jaGFyQ29kZUF0KG4pKXtjYXNlIDM0OmY9XCImcXVvdDtcIjticmVhaztjYXNlIDM4OmY9XCImYW1wO1wiO2JyZWFrO2Nhc2UgNjA6Zj1cIiZsdDtcIjticmVhaztkZWZhdWx0OmNvbnRpbnVlfW4hPT1lJiYobys9ci5zbGljZShlLG4pKSxvKz1mLGU9bisxfXJldHVybiBuIT09ZSYmKG8rPXIuc2xpY2UoZSxuKSksb312YXIgbz0vYWNpdHxleCg/OnN8Z3xufHB8JCl8cnBofGdyaWR8b3dzfG1uY3xudHd8aW5lW2NoXXx6b298Xm9yZHxpdGVyYS9pLGY9MCxpPUFycmF5LmlzQXJyYXk7ZnVuY3Rpb24gdShlLHQsbixvLGksdSl7dHx8KHQ9e30pO3ZhciBhLGMscD10O2lmKFwicmVmXCJpbiBwKWZvcihjIGluIHA9e30sdClcInJlZlwiPT1jP2E9dFtjXTpwW2NdPXRbY107dmFyIGw9e3R5cGU6ZSxwcm9wczpwLGtleTpuLHJlZjphLF9fazpudWxsLF9fOm51bGwsX19iOjAsX19lOm51bGwsX19jOm51bGwsY29uc3RydWN0b3I6dm9pZCAwLF9fdjotLWYsX19pOi0xLF9fdTowLF9fc291cmNlOmksX19zZWxmOnV9O2lmKFwiZnVuY3Rpb25cIj09dHlwZW9mIGUmJihhPWUuZGVmYXVsdFByb3BzKSlmb3IoYyBpbiBhKXZvaWQgMD09PXBbY10mJihwW2NdPWFbY10pO3JldHVybiByLnZub2RlJiZyLnZub2RlKGwpLGx9ZnVuY3Rpb24gYShyKXt2YXIgdD11KGUse3RwbDpyLGV4cHJzOltdLnNsaWNlLmNhbGwoYXJndW1lbnRzLDEpfSk7cmV0dXJuIHQua2V5PXQuX192LHR9dmFyIGM9e30scD0vW0EtWl0vZztmdW5jdGlvbiBsKGUsdCl7aWYoci5hdHRyKXt2YXIgZj1yLmF0dHIoZSx0KTtpZihcInN0cmluZ1wiPT10eXBlb2YgZilyZXR1cm4gZn1pZih0PWZ1bmN0aW9uKHIpe3JldHVybiBudWxsIT09ciYmXCJvYmplY3RcIj09dHlwZW9mIHImJlwiZnVuY3Rpb25cIj09dHlwZW9mIHIudmFsdWVPZj9yLnZhbHVlT2YoKTpyfSh0KSxcInJlZlwiPT09ZXx8XCJrZXlcIj09PWUpcmV0dXJuXCJcIjtpZihcInN0eWxlXCI9PT1lJiZcIm9iamVjdFwiPT10eXBlb2YgdCl7dmFyIGk9XCJcIjtmb3IodmFyIHUgaW4gdCl7dmFyIGE9dFt1XTtpZihudWxsIT1hJiZcIlwiIT09YSl7dmFyIGw9XCItXCI9PXVbMF0/dTpjW3VdfHwoY1t1XT11LnJlcGxhY2UocCxcIi0kJlwiKS50b0xvd2VyQ2FzZSgpKSxzPVwiO1wiO1wibnVtYmVyXCIhPXR5cGVvZiBhfHxsLnN0YXJ0c1dpdGgoXCItLVwiKXx8by50ZXN0KGwpfHwocz1cInB4O1wiKSxpPWkrbCtcIjpcIithK3N9fXJldHVybiBlKyc9XCInK24oaSkrJ1wiJ31yZXR1cm4gbnVsbD09dHx8ITE9PT10fHxcImZ1bmN0aW9uXCI9PXR5cGVvZiB0fHxcIm9iamVjdFwiPT10eXBlb2YgdD9cIlwiOiEwPT09dD9lOmUrJz1cIicrbihcIlwiK3QpKydcIid9ZnVuY3Rpb24gcyhyKXtpZihudWxsPT1yfHxcImJvb2xlYW5cIj09dHlwZW9mIHJ8fFwiZnVuY3Rpb25cIj09dHlwZW9mIHIpcmV0dXJuIG51bGw7aWYoXCJvYmplY3RcIj09dHlwZW9mIHIpe2lmKHZvaWQgMD09PXIuY29uc3RydWN0b3IpcmV0dXJuIHI7aWYoaShyKSl7Zm9yKHZhciBlPTA7ZTxyLmxlbmd0aDtlKyspcltlXT1zKHJbZV0pO3JldHVybiByfX1yZXR1cm4gbihcIlwiK3IpfWV4cG9ydHt1IGFzIGpzeCxsIGFzIGpzeEF0dHIsdSBhcyBqc3hERVYscyBhcyBqc3hFc2NhcGUsYSBhcyBqc3hUZW1wbGF0ZSx1IGFzIGpzeHN9O1xuLy8jIHNvdXJjZU1hcHBpbmdVUkw9anN4UnVudGltZS5tb2R1bGUuanMubWFwXG4iCiAgXSwKICAibWFwcGluZ3MiOiAiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztFQUE4SCxTQUFTLENBQUMsQ0FBQyxJQUFFLElBQUU7QUFBQSxJQUFDLFNBQVEsTUFBSztBQUFBLE1BQUUsR0FBRSxNQUFHLEdBQUU7QUFBQSxJQUFHLE9BQU87QUFBQTtBQUFBLEVBQUUsU0FBUyxDQUFDLENBQUMsSUFBRTtBQUFBLElBQUMsTUFBRyxHQUFFLGNBQVksR0FBRSxXQUFXLFlBQVksRUFBQztBQUFBO0FBQUEsRUFBRSxTQUFTLENBQUMsQ0FBQyxJQUFFLElBQUUsSUFBRTtBQUFBLElBQUMsSUFBSSxJQUFFLElBQUUsSUFBRSxLQUFFLENBQUM7QUFBQSxJQUFFLEtBQUksTUFBSztBQUFBLE1BQVMsTUFBUCxRQUFTLEtBQUUsR0FBRSxNQUFVLE1BQVAsUUFBUyxLQUFFLEdBQUUsTUFBRyxHQUFFLE1BQUcsR0FBRTtBQUFBLElBQUcsSUFBRyxVQUFVLFNBQU8sTUFBSSxHQUFFLFdBQVMsVUFBVSxTQUFPLElBQUUsRUFBRSxLQUFLLFdB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QUFDLEtBQUcsQ0FBQyxFQUFFLFNBQU8sS0FBRyxFQUFFLHdCQUFzQixJQUFFLEVBQUUsc0JBQW9CLEdBQUcsQ0FBQztBQUFBO0FBQUEsRUFBRSxTQUFTLENBQUMsR0FBRTtBQUFBLElBQUMsSUFBRztBQUFBLE1BQUMsU0FBUSxJQUFFLEtBQUUsRUFBRSxFQUFFO0FBQUEsUUFBUSxFQUFFLFNBQU8sTUFBRyxFQUFFLEtBQUssQ0FBQyxHQUFFLEtBQUUsRUFBRSxNQUFNLEdBQUUsS0FBRSxFQUFFLFFBQU8sRUFBRSxFQUFDO0FBQUEsY0FBRTtBQUFBLE1BQVEsRUFBRSxTQUFPLEVBQUUsTUFBSTtBQUFBO0FBQUE7QUFBQSxFQUFHLFNBQVMsQ0FBQyxDQUFDLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRTtBQUFBLElBQUMsSUFBSSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLEtBQUUsTUFBRyxHQUFFLE9BQUssR0FBRSxLQUFFLEdBQUU7QUFBQSxJQUFPLEtBQUksS0FBRSxFQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsRUFBQyxHQUFFLEtBQUUsRUFBRSxLQUFFLElBQUU7QUFBQSxPQUFXLEtBQUUsR0FBRSxJQUFJLFFBQWYsU0FBcUIsS0FBTSxHQUFFLE9BQU4sTUFBVyxHQUFFLEdBQUUsUUFBTSxHQUFFLEdBQUUsTUFBSSxJQUFFLEtBQUUsRUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxFQUFDLEdBQUUsS0FBRSxHQUFFLEtBQUksR0FBRSxPQUFLLEdBQUUsT0FBSyxHQUFFLFFBQU0sR0FBRSxPQUFLLEVBQUUsR0FBRSxLQUFJLE1BQUssRUFBQyxHQUFFLEdBQUUsS0FBSyxHQUFFLEtBQUksR0FBRSxPQUFLLElBQUUsRUFBQyxJQUFTLE1BQU4sUUFBZSxNQUFOLFNBQVUsS0FBRSxNQUFJLEtBQUUsQ0FBQyxFQUFFLElBQUUsR0FBRSxTQUFPLEdBQUUsUUFBTSxHQUFFLE1BQUksS0FBRSxF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LElBQUksSUFBRSxJQUFFLEVBQUM7QUFBQTtBQUFBLE1BQU87QUFBQSxRQUFNLE1BQU4sUUFBUyxHQUFFLE9BQUssR0FBRSxPQUFLLEdBQUUsTUFBSSxHQUFFLEtBQUksR0FBRSxNQUFJLEdBQUUsT0FBSyxLQUFFLEdBQUUsTUFBSSxFQUFFLEdBQUUsS0FBSSxJQUFFLElBQUUsSUFBRSxJQUFFLElBQUUsSUFBRSxJQUFFLEVBQUM7QUFBQSxJQUFFLFFBQU8sS0FBRSxFQUFFLFdBQVMsR0FBRSxFQUFDLEdBQUUsTUFBSSxHQUFFLE1BQVMsWUFBRTtBQUFBO0FBQUEsRUFBRSxTQUFTLENBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxPQUFJLEdBQUUsUUFBTSxHQUFFLElBQUksTUFBSSxPQUFJLEdBQUUsT0FBSyxHQUFFLElBQUksS0FBSyxDQUFDO0FBQUE7QUFBQSxFQUFHLFNBQVMsQ0FBQyxDQUFDLElBQUUsSUFBRSxJQUFFO0FBQUEsSUFBQyxTQUFRLEtBQUUsRUFBRSxLQUFFLEdBQUUsUUFBTztBQUFBLE1BQUksRUFBRSxHQUFFLEtBQUcsR0FBRSxFQUFFLEtBQUcsR0FBRSxFQUFFLEdBQUU7QUFBQSxJQUFFLEVBQUUsT0FBSyxFQUFFLElBQUksSUFBRSxFQUFDLEdBQUUsR0FBRSxLQUFLLFFBQVEsQ0FBQyxJQUFFO0FBQUEsTUFBQyxJQUFHO0FBQUEsUUFBQyxLQUFFLEdBQUUsS0FBSSxHQUFFLE1BQUksQ0FBQyxHQUFFLEdBQUUsS0FBSyxRQUFRLENBQUMsSUFBRTtBQUFBLFVBQUMsR0FBRSxLQUFLLEVBQUM7QUFBQSxTQUFFO0FBQUEsUUFBRSxPQUFNLElBQUU7QUFBQSxRQUFDLEVBQUUsSUFBSSxJQUFFLEdBQUUsR0FBRztBQUFBO0FBQUEsS0FBRztBQUFBO0FBQUEsRUFBRSxTQUFTLENBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxPQUFnQixPQUFPLE1BQWpCLFlBQTBCLE1BQU4sUUFBUyxHQUFFLE1BQUksSUFBRSxLQUFFLEVBQUUsRUFBQyxJQUFFLEdBQUUsSUFBSSxDQUFDLElBQUUsRUFBRSxD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SyxHQUFFLElBQUksSUFBRSxJQUFFLE1BQUcsRUFBQyxHQUFFLEtBQUU7QUFBQSxJQUFFLElBQUksS0FBRSxHQUFFLFFBQU0sR0FBRSxNQUFJLEVBQUMsSUFBRyxDQUFDLEdBQUUsS0FBSSxDQUFDLEVBQUM7QUFBQSxJQUFHLE9BQU8sTUFBRyxHQUFFLEdBQUcsVUFBUSxHQUFFLEdBQUcsS0FBSyxDQUFDLENBQUMsR0FBRSxHQUFFLEdBQUc7QUFBQTtBQUFBLEVBQUcsU0FBUyxFQUFDLENBQUMsSUFBRTtBQUFBLElBQUMsT0FBTyxLQUFFLEdBQUUsR0FBRSxJQUFFLEVBQUM7QUFBQTtBQUFBLEVBQUUsU0FBUyxFQUFDLENBQUMsSUFBRSxJQUFFLElBQUU7QUFBQSxJQUFDLElBQUksS0FBRSxHQUFFLE1BQUksQ0FBQztBQUFBLElBQUUsSUFBRyxHQUFFLElBQUUsSUFBRSxDQUFDLEdBQUUsUUFBTSxHQUFFLEtBQUcsQ0FBQyxLQUFFLEdBQUUsRUFBQyxJQUFFLEdBQU8sV0FBRSxFQUFDLEdBQUUsUUFBUSxDQUFDLElBQUU7QUFBQSxNQUFDLElBQUksS0FBRSxHQUFFLE1BQUksR0FBRSxJQUFJLEtBQUcsR0FBRSxHQUFHLElBQUcsS0FBRSxHQUFFLEVBQUUsSUFBRSxFQUFDO0FBQUEsTUFBRSxPQUFJLE9BQUksR0FBRSxNQUFJLENBQUMsSUFBRSxHQUFFLEdBQUcsRUFBRSxHQUFFLEdBQUUsSUFBSSxTQUFTLENBQUMsQ0FBQztBQUFBLEtBQUcsR0FBRSxHQUFFLE1BQUksSUFBRSxDQUFDLEdBQUUsTUFBSztBQUFBLE1BQUMsSUFBSSxLQUFFLFFBQVEsQ0FBQyxJQUFFLElBQUUsSUFBRTtBQUFBLFFBQUMsSUFBRyxDQUFDLEdBQUUsSUFBSTtBQUFBLFVBQUksT0FBTTtBQUFBLFFBQUcsSUFBSSxLQUFFLEdBQUUsSUFBSSxJQUFJLEdBQUcsT0FBTyxRQUFRLENBQUMsSUFBRTtBQUFBLFVBQUMsT0FBTyxHQUFFO0FBQUEsU0FBSTtBQUFBLFFBQUUsSUFBRyxHQUFFLE1BQU0sUUFBUSxDQUFDLElBQUU7QUFBQSxVQUFDLE9BQU0sQ0FBQyxHQUFFO0FBQUEsU0FBSTtBQUFBLFVBQUUsT0FBTSxDQUFDLE1BQUcsR0FBRSxLQUFLLE1BQUssSUFBRSxJQUFFLEVBQUM7QUFBQSxRQUFFLElBQUksS0FBRSxHQUFFLElBQUksVUFBUTtBQUFBLFFBQUUsT0FBTyxHQUFFLEtBQUssUUFBUSxDQUFDLElBQUU7QUFBQSxVQUFDLElBQUcsR0FBRSxLQUFJO0FBQUEsWUFBQyxJQUFJLEtBQUUsR0FBRSxHQUFHO0FBQUEsWUFBRyxHQUFFLEtBQUcsR0FBRSxLQUFJLEdBQUUsTUFBUyxXQUFFLE9BQUksR0FBRSxHQUFHLE9BQUssS0FBRTtBQUFBLFVBQUc7QUFBQSxTQUFFLEdBQUUsTUFBRyxHQUFFLEtBQUssTUFBSyxJQUFFLElBQUUsRUFBQyxLQUFHO0FBQUE7QUFBQSxNQUFHLEdBQUUsTUFBSTtBQUFBLE1BQUcsTUFBUSx1QkFBSixJQUE4QixxQkFBSixPQUFFO0FBQUEsTUFBc0IsR0FBRSxzQkFBb0IsUUFBUSxDQUFDLElBQUUsSUFBRSxJQUFFO0FBQUEsUUFBQyxJQUFHLEtBQUssS0FBSTtBQUFBLFVBQUMsSUFBSSxLQUFFO0FBQUEsVUFBRSxLQUFPLFdBQUUsR0FBRSxJQUFFLElBQUUsRUFBQyxHQUFFLEtBQUU7QUFBQSxRQUFDO0FBQUEsUUFBQyxNQUFHLEdBQUUsS0FBSyxNQUFLLElBQUUsSUFBRSxFQUFDO0FBQUEsU0FBRyxHQUFFLHdCQUFzQjtBQUFBLElBQUM7QUFBQSxJQUFDLE9BQU8sR0FBRSxPQUFLLEdBQUU7QUFBQTtBQUFBLEVBQUcsU0FBUyxFQUFDLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsR0FBRSxNQUFJLENBQUM7QUFBQSxJQUFFLENBQUMsR0FBRSxPQUFLLEdBQUUsR0FBRSxLQUFJLEVBQUMsTUFBSSxHQUFFLEtBQUcsSUFBRSxHQUFFLElBQUUsSUFBRSxHQUFFLElBQUksSUFBSSxLQUFLLEVBQUM7QUFBQTtFQUFtRixTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxPQUFPLEtBQUUsR0FBRSxHQUFFLFFBQVEsR0FBRTtBQUFBLE1BQUMsT0FBTSxFQUFDLFNBQVEsR0FBQztBQUFBLE9BQUcsQ0FBQyxDQUFDO0FBQUE7RUFBdU4sU0FBUyxFQUFDLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsR0FBRSxNQUFJLENBQUM7QUFBQSxJQUFFLE9BQU8sR0FBRSxHQUFFLEtBQUksRUFBQyxNQUFJLEdBQUUsS0FBRyxHQUFFLEdBQUUsR0FBRSxNQUFJLElBQUUsR0FBRSxNQUFJLEtBQUcsR0FBRTtBQUFBO0VBQXVpQixTQUFTLEVBQUMsR0FBRTtBQUFBLElBQUMsU0FBUSxHQUFFLEtBQUUsR0FBRSxNQUFNLEtBQUc7QUFBQSxNQUFDLElBQUksS0FBRSxHQUFFO0FBQUEsTUFBSSxJQUFHLEdBQUUsT0FBSztBQUFBLFFBQUUsSUFBRztBQUFBLFVBQUMsR0FBRSxJQUFJLEtBQUssRUFBQyxHQUFFLEdBQUUsSUFBSSxLQUFLLEVBQUMsR0FBRSxHQUFFLE1BQUksQ0FBQztBQUFBLFVBQUUsT0FBTSxJQUFFO0FBQUEsVUFBQyxHQUFFLE1BQUksQ0FBQyxHQUFFLEdBQUUsSUFBSSxJQUFFLEdBQUUsR0FBRztBQUFBO0FBQUEsSUFBRTtBQUFBO0FBQUEsRUFBRSxHQUFFLE1BQUksUUFBUSxDQUFDLElBQUU7QUFBQSxJQUFDLEtBQUUsTUFBSyxNQUFHLEdBQUUsRUFBQztBQUFBLEtBQUcsR0FBRSxLQUFHLFFBQVEsQ0FBQyxJQUFFLElBQUU7QUFBQSxJQUFDLE1BQUcsR0FBRSxPQUFLLEdBQUUsSUFBSSxRQUFNLEdBQUUsTUFBSSxHQUFFLElBQUksTUFBSyxNQUFHLEdBQUUsSUFBRSxFQUFDO0FBQUEsS0FBRyxHQUFFLE1BQUksUUFBUSxDQUFDLElBQUU7QUFBQSxJQUFDLE1BQUcsR0FBRSxFQUFDLEdBQUUsS0FBRTtBQUFBLElBQUUsSUFBSSxNQUFHLEtBQUUsR0FBRSxLQUFLO0FBQUEsSUFBSSxPQUFJLE9BQUksTUFBRyxHQUFFLE1BQUksQ0FBQyxHQUFFLEdBQUUsTUFBSSxDQUFDLEdBQUUsR0FBRSxHQUFHLEtBQUssUUFBUSxDQUFDLElBQUU7QUFBQSxNQUFDLEdBQUUsUUFBTSxHQUFFLEtBQUcsR0FBRSxNQUFLLEdBQUUsSUFBRSxHQUFFLE1BQVM7QUFBQSxLQUFFLE1BQUksR0FBRSxJQUFJLEtBQUssRUFBQyxHQUFFLEdBQUUsSUFBSSxLQUFLLEVBQUMsR0FBRSxHQUFFLE1BQUksQ0FBQyxHQUFFLEtBQUUsS0FBSSxLQUFFO0FBQUEsS0FBRyxHQUFFLFNBQU8sUUFBUSxDQUFDLElBQUU7QUFBQSxJQUFDLE1BQUcsR0FBRSxFQUFDO0FBQUEsSUFBRSxJQUFJLEtBQUUsR0FBRTtBQUFBLElBQUksTUFBRyxHQUFFLFFBQU0sR0FBRSxJQUFJLElBQUksV0FBYSxHQUFFLEtBQUssRUFBQyxNQUFaLEtBQWUsT0FBSSxHQUFFLDJCQUF5QixLQUFFLEdBQUUsMEJBQXdCLElBQUcsRUFBQyxJQUFHLEdBQUUsSUFBSSxHQUFHLEtBQUssUUFBUSxDQUFDLElBQUU7QUFBQSxNQUFDLEdBQUUsTUFBSSxHQUFFLE1BQUksR0FBRSxJQUFHLEdBQUUsSUFBTztBQUFBLEtBQUUsSUFBRyxLQUFFLEtBQUU7QUFBQSxLQUFNLEdBQUUsTUFBSSxRQUFRLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxHQUFFLEtBQUssUUFBUSxDQUFDLElBQUU7QUFBQSxNQUFDLElBQUc7QUFBQSxRQUFDLEdBQUUsSUFBSSxLQUFLLEVBQUMsR0FBRSxHQUFFLE1BQUksR0FBRSxJQUFJLE9BQU8sUUFBUSxDQUFDLElBQUU7QUFBQSxVQUFDLE9BQU0sQ0FBQyxHQUFFLE1BQUksR0FBRSxFQUFDO0FBQUEsU0FBRTtBQUFBLFFBQUUsT0FBTSxJQUFFO0FBQUEsUUFBQyxHQUFFLEtBQUssUUFBUSxDQUFDLElBQUU7QUFBQSxVQUFDLEdBQUUsUUFBTSxHQUFFLE1BQUksQ0FBQztBQUFBLFNBQUcsR0FBRSxLQUFFLENBQUMsR0FBRSxHQUFFLElBQUksSUFBRSxHQUFFLEdBQUc7QUFBQTtBQUFBLEtBQUcsR0FBRSxNQUFHLEdB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LFVBQUMsR0FBRSxFQUFFLElBQUUsR0FBRTtBQUFBLFVBQUUsSUFBWSxHQUFFLE1BQU47QUFBQSxZQUFRLEdBQUUsRUFBRSxJQUFFLEdBQUU7QUFBQSxVQUFFLEdBQUUsSUFBRSxHQUFFO0FBQUEsVUFBRSxHQUFFLElBQU87QUFBQSxVQUFFLEdBQUUsRUFBRSxJQUFFO0FBQUEsVUFBRSxHQUFFLElBQUU7QUFBQSxRQUFDO0FBQUEsUUFBQyxPQUFPO0FBQUEsTUFBQztBQUFBLElBQUM7QUFBQTtBQUFBLEVBQUUsU0FBUyxFQUFDLENBQUMsSUFBRSxJQUFFO0FBQUEsSUFBQyxLQUFLLElBQUU7QUFBQSxJQUFFLEtBQUssSUFBRTtBQUFBLElBQUUsS0FBSyxJQUFPO0FBQUEsSUFBRSxLQUFLLElBQU87QUFBQSxJQUFFLEtBQUssSUFBRTtBQUFBLElBQUUsS0FBSyxJQUFRLE1BQU4sT0FBYSxZQUFFLEdBQUU7QUFBQSxJQUFRLEtBQUssSUFBUSxNQUFOLE9BQWEsWUFBRSxHQUFFO0FBQUEsSUFBVSxLQUFLLE9BQVcsTUFBTixPQUFhLFlBQUUsR0FBRTtBQUFBO0FBQUEsRUFBSyxHQUFFLFVBQVUsUUFBTTtBQUFBLEVBQUUsR0FBRSxVQUFVLElBQUUsUUFBUSxHQUFFO0FBQUEsSUFBQyxPQUFNO0FBQUE7QUFBQSxFQUFJLEdBQUUsVUFBVSxJQUFFLFFBQVEsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsTUFBSyxLQUFFLEtBQUs7QUFBQSxJQUFFLElBQUcsT0FBSSxNQUFZLEdBQUUsTUFBTixXQUFRO0FBQUEsTUFBQyxHQUFFLElBQUU7QUFBQSxNQUFFLEtBQUssSUFBRTtBQUFBLE1BQUUsSUFBWSxPQUFKO0FBQUEsUUFBTSxHQUFFLElBQUU7QUFBQSxNQUFPO0FBQUEsV0FBRSxRQUFRLEdBQUU7QUFBQSxVQUFDLElBQUk7QUFBQSxXQUFTLEtBQUUsR0FBRSxNQUFYLFFBQWUsR0FBRSxLQUFLLEVBQUM7QUFBQSxTQUFFO0FBQUEsSUFBQztBQUFBO0FBQUEsRUFBRyxHQUFFLFVBQVUsSUFBRSxRQUFR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RUFBVyxPQUFKLFdBQU0sS0FBRSxHQUFFO0FBQUEsTUFBRSxJQUFHLEdBQUUsRUFBRSxNQUFJLEdBQUUsS0FBRyxDQUFDLEdBQUUsRUFBRSxFQUFFLEtBQUcsR0FBRSxFQUFFLE1BQUksR0FBRTtBQUFBLFFBQUUsT0FBTTtBQUFBLElBQUcsT0FBTTtBQUFBO0FBQUEsRUFBRyxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxTQUFRLEtBQUUsR0FBRSxFQUFXLE9BQUosV0FBTSxLQUFFLEdBQUUsR0FBRTtBQUFBLE1BQUMsSUFBSSxLQUFFLEdBQUUsRUFBRTtBQUFBLE1BQUUsSUFBWSxPQUFKO0FBQUEsUUFBTSxHQUFFLElBQUU7QUFBQSxNQUFFLEdBQUUsRUFBRSxJQUFFO0FBQUEsTUFBRSxHQUFFLElBQUU7QUFBQSxNQUFHLElBQVksR0FBRSxNQUFOLFdBQVE7QUFBQSxRQUFDLEdBQUUsSUFBRTtBQUFBLFFBQUU7QUFBQSxNQUFLO0FBQUEsSUFBQztBQUFBO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsR0FBRSxHQUFFLEtBQU87QUFBQSxJQUFFLE9BQWUsT0FBSixXQUFNO0FBQUEsTUFBQyxJQUFJLEtBQUUsR0FBRTtBQUFBLE1BQUUsSUFBUSxHQUFFLE1BQVAsSUFBUztBQUFBLFFBQUMsR0FBRSxFQUFFLEVBQUUsRUFBQztBQUFBLFFBQUUsSUFBWSxPQUFKO0FBQUEsVUFBTSxHQUFFLElBQUUsR0FBRTtBQUFBLFFBQUUsSUFBWSxHQUFFLE1BQU47QUFBQSxVQUFRLEdBQUUsRUFBRSxJQUFFO0FBQUEsTUFBQyxFQUFNO0FBQUEsYUFBRTtBQUFBLE1BQUUsR0FBRSxFQUFFLElBQUUsR0FBRTtBQUFBLE1BQUUsSUFBWSxHQUFFLE1BQU47QUFBQSxRQUFRLEdBQUUsSUFBTztBQUFBLE1BQUUsS0FBRTtBQUFBLElBQUM7QUFBQSxJQUFDLEdBQUUsSUFBRTtBQUFBO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFLElBQUU7QUFBQSxJQUFDLEdBQUUsS0FBSyxNQUFVLFNBQUM7QUFBQSxJQUFFLEtBQUssSUFBRTtBQUFBLElBQUUsS0FBSyxJQUFPO0FBQUEsSUFBRSxLQUFLLElBQUUsS0FBRTtBQUFBLElBQUUsS0FBSyxJQUFFO0FBQUEsSUFBRSxLQUFLLElBQVEsTUFBTixPQUFhLFlBQUUsR0FBRTtBQUFBLElBQVEsS0FBSyxJQUFRLE1BQU4sT0FBYSxZQUFFLEdBQUU7QUFBQSxJQUFVLEtBQUssT0FBVyxNQUFOLE9BQWEsWUFBRSxHQUFFO0FBQUE7QUFBQSxFQUFLLEdBQUUsWUFBVSxJQUFJO0FBQUEsRUFBRSxHQUFFLFVBQVUsSUFBRSxRQUFRLEdBQUU7QUFBQSxJQUFDLEtBQUssS0FBRztBQUFBLElBQUcsSUFBRyxJQUFFLEtBQUs7QUFBQSxNQUFFLE9BQU07QUFBQSxJQUFHLEtBQVEsS0FBRyxLQUFLLE1BQWI7QUFBQSxNQUFnQixPQUFNO0FBQUEsSUFBRyxLQUFLLEtBQUc7QUFBQSxJQUFHLElBQUcsS0FBSyxNQUFJO0FBQUEsTUFBRSxPQUFNO0FBQUEsSUFBRyxLQUFLLElBQUU7QUFBQSxJQUFFLEtBQUssS0FBRztBQUFBLElBQUUsSUFBRyxLQUFLLElBQUUsS0FBRyxDQUFDLEdBQUUsSUFBSSxHQUFFO0FBQUEsTUFBQyxLQUFLLEtBQUc7QUFBQSxNQUFHLE9BQU07QUFBQSxJQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUU7QUFBQSxJQUFFLElBQUc7QUFBQSxNQUFDLEdBQUUsSUFBSTtBQUFBLE1BQUUsS0FBRTtBQUFBLE1BQUssSUFBSSxLQUFFLEtBQUssRUFBRTtBQUFBLE1BQUUsSUFBRyxLQUFHLEtBQUssS0FBRyxLQUFLLE1BQUksTUFBTyxLQUFLLE1BQVQsR0FBVztBQUFBLFFBQUMsS0FBSyxJQUFFO0FBQUEsUUFBRSxLQUFLLEtBQUc7QUFBQSxRQUFJLEtBQUs7QUFBQSxNQUFHO0FBQUEsTUFBRSxPQUFNLElBQUU7QUFBQSxNQUFDLEtBQUssSUFBRTtBQUFBLE1BQUUsS0FBSyxLQUFHO0FBQUEsTUFBRyxLQUFLO0FBQUE7QUFBQSxJQUFJLEtBQUU7QUFBQSxJQUFFLEdBQUUsSUFBSTtBQUFBLElBQUUsS0FBSyxLQUFHO0FBQUEsSUFBRyxPQUFNO0FBQUE7QUFBQSxFQUFJLEdBQUUsVUFBVSxJQUFFLFFBQVEsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFZLEtBQUssTUFBVCxXQUFXO0FBQUEsTUFBQyxLQUFLLEtBQUc7QUFBQSxNQUFHLFNBQVEsS0FBRSxLQUFLLEVBQVcsT0FBSixXQUFNLEtBQUUsR0FBRTtBQUFBLFFBQUUsR0FBRSxFQUFFLEVBQUUsRUFBQztBQUFBLElBQUM7QUFBQSxJQUFDLEdBQUUsVUFBVSxFQUFFLEtBQUssTUFBSyxFQUFDO0FBQUE7QUFBQSxFQUFHLEdBQUUsVUFBVSxJQUFFLFFBQVEsQ0FBQyxJQUFFO0FBQUEsSUFBQyxJQUFZLEtBQUssTUFBVCxXQUFXO0FBQUEsTUFBQyxHQUFFLFVBQVUsRUFBRSxLQUFLLE1BQUssRUFBQztBQUFBLE1BQUUsSUFBWSxLQUFLLE1BQVQsV0FBVztBQUFBLFFBQUMsS0FBSyxLQUFHO0FBQUEsUUFBSSxTQUFRLEtBQUUsS0FBSyxFQUFXLE9BQUosV0FBTSxLQUFFLEdBQUU7QUFBQSxVQUFFLEdBQUUsRUFBRSxFQUFFLEVBQUM7QUFBQSxNQUFDO0FBQUEsSUFBQztBQUFBO0FBQUEsRUFBRyxHQUFFLFVBQVUsSUFBRSxRQUFRLEdBQUU7QUFBQSxJQUFDLElBQUcsRUFBRSxJQUFFLEtBQUssSUFBRztBQUFBLE1BQUMsS0FBSyxLQUFHO0FBQUEsTUFBRSxTQUFRLEtBQUUsS0FBSyxFQUFXLE9BQUosV0FBTSxLQUFFLEdBQUU7QUFBQSxRQUFFLEdBQUUsRUFBRSxFQUFFO0FBQUEsSUFBQztBQUFBO0FBQUEsRUFBRyxPQUFPLGVBQWUsR0FBRSxXQUFVLFNBQVEsRUFBQyxLQUFJLFFBQVEsR0FBRTtBQUFBLElBQUMsSUFBRyxJQUFFLEtBQUs7QUFBQSxNQUFFLE1BQU0sSUFBSSxNQUFNLGdCQUFnQjtBQUFBLElBQUUsSUFBSSxLQUFFLEdBQUUsSUFBSTtBQUFBLElBQUUsS0FBSyxFQUFFO0FBQUEsSUFBRSxJQUFZLE9BQUo7QUFBQSxNQUFNLEdBQUUsSUFBRSxLQUFLO0FBQUEsSUFBRSxJQUFHLEtBQUcsS0FBSztBQUFBLE1BQUUsTUFBTSxLQUFLO0FBQUEsSUFBRSxPQUFPLEtBQUs7QUFBQSxJQUFFLENBQUM7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUUsSUFBRTtBQUFBLElBQUMsT0FBTyxJQUFJLEdBQUUsSUFBRSxFQUFDO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLElBQUksS0FBRSxHQUFFO0FBQUEsSUFBRSxHQUFFLElBQU87QUFBQSxJQUFFLElBQWUsT0FBTyxNQUFuQixZQUFxQjtBQUFBLE1BQUM7QUFBQSxNQUFJLElBQUksS0FBRTtBQUFBLE1BQUUsS0FBTztBQUFBLE1BQUUsSUFBRztBQUFBLFFBQUMsR0FBRTtBQUFBLFFBQUUsT0FBTSxJQUFFO0FBQUEsUUFBQyxHQUFFLEtBQUc7QUFBQSxRQUFHLEdBQUUsS0FBRztBQUFBLFFBQUUsR0FBRSxFQUFDO0FBQUEsUUFBRSxNQUFNO0FBQUEsZ0JBQUU7QUFBQSxRQUFRLEtBQUU7QUFBQSxRQUFFLEdBQUU7QUFBQTtBQUFBLElBQUU7QUFBQTtBQUFBLEVBQUUsU0FBUyxFQUFDLENBQUMsSUFBRTtBQUFBLElBQUMsU0FBUSxLQUFFLEdBQUUsRUFBVyxPQUFKLFdBQU0sS0FBRSxHQUFFO0FBQUEsTUFBRSxHQUFFLEVBQUUsRUFBRSxFQUFDO0FBQUEsSUFBRSxHQUFFLElBQU87QUFBQSxJQUFFLEdBQUUsSUFBTztBQUFBLElBQUUsR0FBRSxFQUFDO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLElBQUcsT0FBSTtBQUFBLE1BQUssTUFBTSxJQUFJLE1BQU0scUJBQXFCO0FBQUEsSUFBRSxHQUFFLElBQUk7QUFBQSxJQUFFLEtBQUU7QUFBQSxJQUFFLEtBQUssS0FBRztBQUFBLElBQUcsSUFBRyxJQUFFLEtBQUs7QUFBQSxNQUFFLEdBQUUsSUFBSTtBQUFBLElBQUUsR0FBRTtBQUFBO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFLElBQUU7QUFBQSxJQUFDLEtBQUssSUFBRTtBQUFBLElBQUUsS0FBSyxJQUFPO0FBQUEsSUFBRSxLQUFLLElBQU87QUFBQSxJQUFFLEtBQUssSUFBTztBQUFBLElBQUUsS0FBSyxJQUFFO0FBQUEsSUFBRyxLQUFLLE9BQVcsTUFBTixPQUFhLFlBQUUsR0FBRTtBQUFBLElBQUssSUFBRztBQUFBLE1BQUUsR0FBRSxLQUFLLElBQUk7QUFBQTtBQUFBLEVBQUUsR0FBRSxVQUFVLElBQUUsUUFBUSxHQUFFO0FBQUEsSUFBQyxJQUFJLEtBQUUsS0FBSyxFQUFFO0FBQUEsSUFBRSxJQUFHO0FBQUEsTUFBQyxJQUFHLElBQUUsS0FBSztBQUFBLFFBQUU7QUFBQSxNQUFPLElBQVksS0FBSyxNQUFUO0FBQUEsUUFBVztBQUFBLE1BQU8sSUFBSSxLQUFFLEtBQUssRUFBRTtBQUFBLE1BQUUsSUFBZSxPQUFPLE1BQW5CO0FBQUEsUUFBcUIsS0FBSyxJQUFFO0FBQUEsY0FBRTtBQUFBLE1BQVEsR0FBRTtBQUFBO0FBQUE7QUFBQSxFQUFJLEdBQUUsVUFBVSxJQUFFLFFBQVEsR0FBRTtBQUFBLElBQUMsSUFBRyxJQUFFLEtBQUs7QUFBQSxNQUFFLE1BQU0sSUFBSSxNQUFNLGdCQUFnQjtBQUFBLElBQUUsS0FBSyxLQUFHO0FBQUEsSUFBRSxLQUFLLEtBQUc7QUFBQSxJQUFHLEdBQUUsSUFBSTtBQUFBLElBQUUsR0FBRSxJQUFJO0FBQUEsSUFBRTtBQUFBLElBQUksSUFBSSxLQUFFO0FBQUEsSUFBRSxLQUFFO0FBQUEsSUFBSyxPQUFPLEdBQUUsS0FBSyxNQUFLLEVBQUM7QUFBQTtBQUFBLEVBQUcsR0FBRSxVQUFVLElBQUUsUUFBUSxHQUFFO0FBQUEsSUFBQyxJQUFHLEVBQUUsSUFBRSxLQUFLLElBQUc7QUFBQSxNQUFDLEtBQUssS0FBRztBQUFBLE1BQUUsS0FBSyxJQUFFO0FBQUEsTUFBRSxLQUFFO0FBQUEsSUFBSTtBQUFBO0FBQUEsRUFBRyxHQUFFLFVBQVUsSUFBRSxRQUFRLEdBQUU7QUFBQSxJQUFDLEtBQUssS0FBRztBQUFBLElBQUUsSUFBRyxFQUFFLElBQUUsS0FBSztBQUFBLE1BQUcsR0FBRSxJQUFJO0FBQUE7QUFBQSxFQUFHLEdBQUUsVUFBVSxVQUFRLFFBQVEsR0FBRTtBQUFBLElBQUMsS0FBSyxFQUFFO0FBQUE7QUFBQSxFQUFHLFNBQVMsRUFBQyxDQUFDLElBQUUsSUFBRTtBQUFBLElBQUMsSUFBSSxLQUFFLElBQUksR0FBRSxJQUFFLEVBQUM7QUFBQSxJQUFFLElBQUc7QUFBQSxNQUFDLEdBQUUsRUFBRTtBQUFBLE1BQUUsT0FBTSxJQUFFO0FBQUEsTUFBQyxHQUFFLEVBQUU7QUFBQSxNQUFFLE1BQU07QUFBQTtBQUFBLElBQUUsSUFBSSxLQUFFLEdBQUUsRUFBRSxLQUFLLEVBQUM7QUFBQSxJQUFFLEdBQUUsT0FBTyxXQUFTO0FBQUEsSUFBRSxPQUFPO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLE9BQU8sUUFBUSxHQUFFO0FBQUEsTUFBQyxJQUFJLEtBQUUsV0FBVSxLQUFFO0FBQUEsTUFBSyxPQUFPLEdBQUUsUUFBUSxHQUFFO0FBQUEsUUFBQyxPQUFPLEdBQUUsUUFBUSxHQUFFO0FBQUEsVUFBQyxPQUFPLEdBQUUsTUFBTSxJQUFFLENBQUMsRUFBRSxNQUFNLEtBQUssRUFBQyxDQUFDO0FBQUEsU0FBRTtBQUFBLE9BQUU7QUFBQTtBQUFBO0FBQUEsRUFBRyxTQUFTLEVBQUMsR0FBRTtBQUFBLElBQUMsSUFBSSxLQUFFO0FBQUEsSUFBRSxLQUFFLENBQUM7QUFBQSxJQUFFLE9BQU8sUUFBUSxHQUFFO0FBQUEsTUFBQyxJQUFJLEtBQUU7QUFBQSxNQUFFLElBQUcsTUFBRztBQUFBLFFBQUUsS0FBRSxHQUFFLE9BQU8sRUFBQztBQUFBLE1BQUUsS0FBRTtBQUFBLE1BQUUsT0FBTztBQUFBO0FBQUE7QUFBQSxFQUFHLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLE9BQU8sUUFBUSxHQUFFO0FBQUEsTUFBQyxJQUFJLElBQUUsSUFBRSxLQUFFLEdBQUU7QUFBQSxNQUFFLElBQUc7QUFBQSxRQUFDLEtBQUUsR0FBRSxNQUFXLFdBQUUsQ0FBQyxFQUFFLE1BQU0sS0FBSyxTQUFTLENBQUM7QUFBQSxRQUFFLE9BQU0sSUFBRTtBQUFBLFFBQUMsS0FBTztBQUFBLFFBQUUsTUFBTTtBQUFBLGdCQUFFO0FBQUEsUUFBUSxLQUFFLEdBQUU7QUFBQTtBQUFBLE1BQUUsU0FBUSxNQUFLO0FBQUEsUUFBRSxJQUFlLE9BQU8sR0FBRSxPQUFyQjtBQUFBLFVBQXdCLEdBQUUsTUFBRyxHQUFFLEdBQUUsR0FBRTtBQUFBLE1BQUUsR0FBRSxPQUFPLFdBQVMsR0FBRSxRQUFRLEdBQUU7QUFBQSxRQUFDLElBQUc7QUFBQSxVQUFFLFNBQVEsS0FBRSxFQUFFLEtBQUUsR0FBRSxRQUFPO0FBQUEsWUFBSSxHQUFFLElBQUcsUUFBUTtBQUFBLFFBQUUsS0FBTztBQUFBLE9BQUU7QUFBQSxNQUFFLE9BQU87QUFBQTtBQUFBOzs7RURBejFKLElBQUk7QUFBQSxFQUFKLElBQU07QUFBQSxFQUFOLElBQVE7QUFBQSxFQUFSLElBQVUsS0FBZSxPQUFPLFVBQXBCLGVBQTRCLENBQUMsQ0FBQyxPQUFPO0FBQUEsRUFBakQsSUFBNkUsS0FBRSxDQUFDO0FBQUEsRUFBaEYsSUFBa0YsS0FBRSxDQUFDO0FBQUEsRUFBRSxHQUFFLFFBQVEsR0FBRTtBQUFBLElBQUMsS0FBRSxLQUFLO0FBQUEsR0FBRSxFQUFFO0FBQUEsRUFBRSxTQUFTLEVBQUMsQ0FBQyxJQUFFLElBQUU7QUFBQSxJQUFDLEVBQUUsTUFBRyxHQUFFLEtBQUssTUFBSyxFQUFFLE9BQUksUUFBUSxHQUFFLEVBQUU7QUFBQTtBQUFBLEVBQUUsU0FBUyxFQUFDLENBQUMsSUFBRTtBQUFBLElBQUMsSUFBRyxJQUFFO0FBQUEsTUFBQyxJQUFJLEtBQUU7QUFBQSxNQUFFLEtBQU87QUFBQSxNQUFFLEdBQUU7QUFBQSxJQUFDO0FBQUEsSUFBQyxLQUFFLE1BQUcsR0FBRSxFQUFFO0FBQUE7QUFBQSxFQUFFLFNBQVMsRUFBQyxDQUFDLElBQUU7QUFBQSxJQUFDLElBQUksS0FBRSxNQUFLLEtBQUUsR0FBRSxNQUFLLEtBQUUsVUFBVSxFQUFDO0FBQUEsSUFBRSxHQUFFLFFBQU07QUFBQSxJQUFFLElBQUksS0FBRSxHQUFFLFFBQVEsR0FBRTtBQUFBLE1BQUMsSUFBSSxLQUFFLElBQUUsS0FBRSxHQUFFO0FBQUEsTUFBSSxPQUFNLEtBQUUsR0FBRTtBQUFBLFFBQUcsSUFBRyxHQUFFLEtBQUk7QUFBQSxVQUFDLEdBQUUsSUFBSSxRQUFNO0FBQUEsVUFBRTtBQUFBLFFBQUs7QUFBQSxNQUFDLElBQUksS0FBRSxHQUFFLFFBQVEsR0FBRTtBQUFBLFFBQUMsSUFBSSxLQUFFLEdBQUUsTUFBTTtBQUFBLFFBQU0sT0FBVyxPQUFKLElBQU0sSUFBTyxPQUFMLE9BQU8sS0FBRyxNQUFHO0FBQUEsT0FBRyxHQUFFLEtBQUUsR0FBRSxRQUFRLEdBQUU7QUFBQSxRQUFDLE9BQU0sQ0FBQyxNQUFNLFFBQVEsR0FBRSxLQUFLLEtBQUcsQ0FBQyxFQUFFLEdBQUUsS0FBSztBQUFBLE9BQUUsR0FBRSxLQUFFLEdBQUUsUUFBUSxHQUFFO0FBQUEsUUFBQyxLQUFLLElBQUU7QUFBQSxRQUFFLElBQUcsR0FBRSxPQUFNO0FBQUEsVUFBQyxJQUFJLEtBQUUsR0FBRTtBQUFBLFVBQU0sSUFBRyxHQUFFLE9BQUssR0FBRSxJQUFJLE9BQVMsR0FBRSxJQUFJLElBQUksYUFBZDtBQUFBLFlBQXVCLEdBQUUsSUFBSSxJQUFJLE9BQUs7QUFBQSxRQUFDO0FBQUEsT0FBRSxHQUFFLEtBQUUsR0FBRSxLQUFLO0FBQUEsTUFBRSxHQUFFLEtBQUssSUFBRSxRQUFRLEdBQUU7QUFBQSxRQUFDLEdBQUU7QUFBQSxRQUFFLEdBQUUsS0FBSyxJQUFJO0FBQUE7QUFBQSxNQUFHLE9BQU0sQ0FBQyxJQUFFLEVBQUM7QUFBQSxPQUFHLENBQUMsQ0FBQyxHQUFFLEtBQUUsR0FBRSxJQUFHLEtBQUUsR0FBRTtBQUFB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YyxHQUFHO0FBQUEsSUFDeEIsdUJBQ0UsR0FnQ0UsT0FoQ0Y7QUFBQSxNQUFLLE9BQU07QUFBQSxNQUFYLFVBZ0NFO0FBQUEsd0JBL0JBLEdBQWdDLE1BQWhDO0FBQUE7QUFBQSw0Q0FBZ0M7QUFBQSx3QkFDaEMsR0FLRSxLQUxGO0FBQUEsVUFBRyxPQUFNO0FBQUEsVUFBVCxVQUtFO0FBQUEsWUFMRjtBQUFBLDRCQUVFLEdBQUMsTUFBRCxxQ0FBSTtBQUFBLFlBRk47QUFBQSxZQUdjLE9BQU8sUUFBUSxjQUFjLFlBQVk7QUFBQSxZQUh2RDtBQUFBO0FBQUEsMkNBS0U7QUFBQSx3QkFDRixHQU9FLE9BUEY7QUFBQSxVQUFLLE9BQU07QUFBQSxVQUFYLFVBT0U7QUFBQSw0QkFOQSxHQUFDLHFCQUFELHFDQUFxQjtBQUFBLDRCQUNyQixHQUFDLGNBQUQscUNBQWM7QUFBQSw0QkFDZCxHQUFDLGFBQUQscUNBQWE7QUFBQSw0QkFDYixHQUFDLGlCQUFELHFDQUFpQjtBQUFBLDRCQUNqQixHQUFDLG1CQUFELHFDQUFtQjtBQUFBLDRCQUNuQixHQUFDLGFBQUQscUNBQWE7QUFBQTtBQUFBLFdBTmYsZ0NBT0U7QUFBQSx3QkFDRixHQUFtQyxNQUFuQztBQUFBO0FBQUEsNENBQW1DO0FBQUEsd0JBQ25DLEdBS0UsT0FMRjtBQUFBLFVBQUssT0FBTTtBQUFBLFVBQVgsVUFLRTtBQUFBLDRCQUpBLEdBQUMsYUFBRCxxQ0FBYTtBQUFBLDRCQUNiLEdBQUMsb0JBQUQscUNBQW9CO0FBQUEsNEJBQ3BCLEdBQUMsa0JBQUQscUNBQWtCO0FBQUEsNEJBQ2xCLEdBQUMseUJBQUQscUNBQXlCO0FBQUE7QUFBQSxXQUozQixnQ0FLRTtBQUFBLHdCQUNGLEdBQXNDLE1BQXRDO0FBQUE7QUFBQSw0Q0FBc0M7QUFBQSx3QkFDdEMsR0FLRSxPQUxGO0FBQUEsVUFBSyxPQUFNO0FBQUEsVUFBWCxVQUtFO0FBQUEsNEJBSkEsR0FBQyxhQUFELHFDQUFhO0FBQUEsNEJBQ2IsR0FBQyxtQkFBRCxxQ0FBbUI7QUFBQSw0QkFDbkIsR0FBQyxZQUFELHFDQUFZO0FBQUEsNEJBQ1osR0FBQyxvQkFBRCxxQ0FBb0I7QUFBQTtBQUFBLFdBSnRCLGdDQUtFO0FBQUEsd0JBQ0YsR0FBaUIsTUFBakI7QUFBQTtBQUFBLDRDQUFpQjtBQUFBLHdCQUNqQixHQUFDLGtCQUFELHFDQUFrQjtBQUFBO0FBQUEsT0EvQnBCLGdDQWdDRTtBQUFBO0FBQUEsRUFJTixJQUFNLE9BQU8sU0FBUyxlQUFlLEtBQUs7QUFBQSxFQUMxQyxJQUFJLENBQUM7QUFBQSxJQUFNLE1BQU0sSUFBSSxNQUFNLHFCQUFxQjtBQUFBLEVBQ2hELGtCQUFPLEdBQUMsZ0JBQUQscUNBQWdCLEdBQUksSUFBSTsiLAogICJkZWJ1Z0lkIjogIkRFQ0JBODkyQTEyRURBQjg2NDc1NkUyMTY0NzU2RTIxIiwKICAibmFtZXMiOiBbXQp9
