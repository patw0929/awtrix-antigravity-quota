# @name    Antigravity Quota
# @desc    Antigravity 5-hour and weekly limits for the Gemini and the Claude/GPT pools, pushed by the Quota Monitor plugin
# @author  patw (idea from llegomark/ag-telemetry)
# @version 2.1.0
# @display 52x16
# @config  mode   select "Show"              default=used options="used,left" group=Display help="used = percent used (like Claude-Direct), left = percent remaining"
# @config  flip   number "Seconds per page"  default=3 min=1 max=10 unit=s group=Display help="How long each page stays on screen"
# @config  stale  number "Stale after"       default=15 min=5 max=120 unit=min group=Display help="Red dot when no update came for this long (Antigravity closed)"
# @config  warn   number "Warning threshold" default=50 min=1 max=99 unit=% group=Thresholds help="Bar turns yellow from this much used"
# @config  high   number "High threshold"    default=80 min=1 max=100 unit=% group=Thresholds help="Bar turns red from this much used"
import json

# Antigravity mark, 14 x 13, row by row (0 = off)
var ARCH = [
      0, 0, 0, 0, 0, 0, 0xFF9F24, 0xFF7734, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0xD4C931, 0xE5A632, 0xF97932, 0xFF5837, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0x9AD455, 0x99C35B, 0xAEAD67, 0xCE8960, 0xED654E, 0xFF483D, 0, 0, 0, 0,
      0, 0, 0, 0, 0x69C572, 0x62B991, 0x71AAA6, 0x9293A0, 0xBD7788, 0xE25967, 0, 0, 0, 0,
      0, 0, 0, 0, 0x48B9A5, 0x3FACCA, 0x459FDD, 0x5B92DC, 0x797BC3, 0xB072A7, 0xCC6994, 0, 0, 0,
      0, 0, 0, 0x46BBB7, 0x31A8D3, 0x2A99F1, 0x2D91FF, 0x3A8CFF, 0x4781F5, 0x636ED9, 0x9877C5, 0, 0, 0,
      0, 0, 0, 0x2EA7D7, 0x2597F6, 0x2B8DFF, 0x3089FF, 0x3689FF, 0x3D89FF, 0x3D7CFF, 0x516CEB, 0, 0, 0,
      0, 0, 0, 0x2297F4, 0x298CFF, 0x3B8FFF, 0, 0, 0x3D8CFF, 0x3D87FF, 0x3D7FFF, 0, 0, 0,
      0, 0, 0x2E9EF7, 0x278EFF, 0x3D90FF, 0, 0, 0, 0, 0x3D8AFF, 0x3D88FF, 0x3D83FF, 0, 0,
      0, 0, 0x2C96FF, 0x328CFF, 0, 0, 0, 0, 0, 0, 0x3D8BFF, 0x3D89FF, 0, 0,
      0, 0x3D9EFF, 0x3590FF, 0x3D90FF, 0, 0, 0, 0, 0, 0, 0, 0x3B8AFF, 0x3D8AFF, 0,
      0, 0x3D97FF, 0x3D91FF, 0, 0, 0, 0, 0, 0, 0, 0, 0x3D8BFF, 0x3D8BFF, 0,
      0x3D94FF, 0x3D91FF, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x3D8CFF, 0x3D8CFF
]

# Data arrives in the store key "q" from the Quota Monitor plugin in Antigravity:
#   {"t": <epoch s of push>, "g": [{"k": "G", "s": [used %, reset epoch], "w": [used %, reset epoch]}, ...]}
class AntigravityQuota
  var left, per, stale, warn, high
  var g, t, sig, since, lm
  var pr, ink
  var arch, gem, claude

  def init()
    self.left = store.get("mode", "used") == "left"
    self.per = int(store.get("flip", 3)) * 1000
    self.stale = int(store.get("stale", 15)) * 60
    self.warn = int(store.get("warn", 50))
    self.high = int(store.get("high", 80))
    self.since = 0
    self.sig = nil
    self.g = []
    self.t = 0
    self.lm = -1
    self.arch = ARCH
    self.gem = [0x08, 0x08, 0x1C, 0x7F, 0x1C, 0x08, 0x08]
    self.claude = [0x49, 0x2A, 0x1C, 0x7F, 0x1C, 0x2A, 0x49]
    self.read()
    self.build()
  end

  # Re-read the store; true when the plugin pushed something new
  def read()
    var q = store.get("q")
    if type(q) == "string" q = json.load(q) end
    if !isinstance(q, map) return false end
    var t = q.find("t")
    if t == self.sig return false end
    self.sig = t
    self.t = type(t) == "int" || type(t) == "real" ? int(t) : 0
    var out = []
    var g = q.find("g")
    if isinstance(g, list)
      for e:g
        if isinstance(e, map) && (e.find("s") != nil || e.find("w") != nil) out.push(e) end
      end
    end
    self.g = out
    return true
  end

  def loop()
    var mi = epoch_ms() / 60000
    if self.read() || mi != self.lm
      self.lm = mi
      self.build()
    end
  end

  def fresh()
    var now = int(epoch_ms() / 1000)
    return self.t > 0 && now > 0 && now - self.t <= self.stale
  end

  # [used %, minutes to reset]; a passed reset means the window is full again
  def win(v, now)
    if !isinstance(v, list) || size(v) < 1 return [nil, nil] end
    var u = v[0]
    if type(u) != "int" && type(u) != "real" return [nil, nil] end
    u = int(u)
    var r = size(v) > 1 ? v[1] : 0
    if type(r) != "int" && type(r) != "real" r = 0 end
    r = int(r)
    if r > 0 && now > 0 && r <= now return [0, nil] end
    return [u, r > 0 && now > 0 && u > 0 ? (r - now) / 60 : nil]
  end

  def level(p)
    return p == nil ? 0 : (p >= self.high ? 2 : (p >= self.warn ? 1 : 0))
  end

  # Page = [pool letter, mood, rows]; each pool gets a percent page and, while a window runs, a reset page
  def build()
    self.ink = settings.get("textColor")
    if self.ink == nil self.ink = 0xFFFFFF end
    var now = int(epoch_ms() / 1000)
    var pr = []
    for e:self.g
      var s = self.win(e.find("s"), now)
      var w = self.win(e.find("w"), now)
      var k = str(e.find("k", "?"))
      var worst = s[0] == nil ? w[0] : (w[0] == nil || s[0] > w[0] ? s[0] : w[0])
      var mo = self.level(worst)
      var pa = []
      self.row(pa, 0, "5h", s, false)
      self.row(pa, 8, "7d", w, false)
      pr.push([k, mo, pa])
      if s[1] != nil || w[1] != nil
        var pb = []
        self.row(pb, 0, "5h", s, true)
        self.row(pb, 8, "7d", w, true)
        pr.push([k, mo, pb])
      end
    end
    self.pr = pr
  end

  def row(l, oy, lab, w, t)
    var p = w[0]
    var m = w[1]
    if p != nil && p > 100 p = 100 end
    var c = p == nil ? 0x8090A0 : (p >= self.high ? 0xFF0000 : (p >= self.warn ? 0xFFDE21 : 0x4CC38A))
    var s = "--"
    var x = 44
    var sc = p == nil ? c : self.ink
    var pc = false
    if t
      if m != nil
        s = m < 60 ? str(m) + "m" : (m < 1440 ? str(m / 60) + "h" + (m % 60 < 10 ? "0" : "") + str(m % 60) : str(m / 1440) + "d" + str(m % 1440 / 60) + "h")
        x = 53 - 4 * size(s)
        if x < 24 + 4 * size(lab) + 1 lab = "" end
      end
      sc = self.ink
    elif p != nil
      s = str(self.left ? 100 - p : p)
      x = 49 - 4 * size(s)
      pc = true
    end
    var bp = p == nil ? 0 : (self.left ? 100 - p : p)
    var n = (bp * 28 + 50) / 100
    if bp > 0 && n < 1 n = 1 end
    l.push(oy) l.push(lab) l.push(s) l.push(x) l.push(sc) l.push(pc) l.push(c) l.push(n)
  end

  def should_show() return true end

  def duration() return size(self.pr) == 0 ? 5000 : size(self.pr) * self.per end
  def on_show() self.since = now_ms() end

  def draw()
    clear(0)
    if size(self.pr) == 0
      # Nothing pushed yet: install the Quota Monitor plugin and turn on push
      font("large")
      if text_ink_width("WAIT") > 28 font("small") end
      text(24, 11, "WAIT", 0xFF8020)
      font("small")
      self.orb(3, "")
      return
    end
    # Cycle rather than clamp: a data push can reload the app mid-show, so on_show is not guaranteed
    var p = ((now_ms() - self.since) / self.per) % size(self.pr)
    var pg = self.pr[p]
    var l = pg[2]
    var i = 0
    while i < size(l)
      var y = l[i]
      if size(l[i + 1]) > 0 text(24, 5 + y, l[i + 1], 0x8090A0) end
      text(l[i + 3], 5 + y, l[i + 2], l[i + 4])
      if l[i + 5]
        var c = l[i + 4]
        pixel(49, y, c) pixel(51, y, c) pixel(51, y + 1, c) pixel(50, y + 2, c)
        pixel(49, y + 3, c) pixel(49, y + 4, c) pixel(51, y + 4, c)
      end
      rect_fill(24, 6 + y, 28, 1, 0x10281C)
      if l[i + 7] > 0 rect_fill(24, 6 + y, l[i + 7], 1, l[i + 6]) end
      i += 8
    end
    self.orb(pg[1], pg[0])
    # Red dot: last known numbers, nothing new for a while (Antigravity closed)
    if !self.fresh() pixel(51, 15, 0xFF2020) end
  end

  # Antigravity mark (14x13, sampled from the app icon) floating above its shadow;
  # it floats faster as the pool fills up, and the shadow takes the state colour.
  # Beside it the pool's model mark: Gemini sparkle, or the Claude burst for Claude and GPT.
  def orb(mo, k)
    var period = mo == 2 ? 700 : (mo == 1 ? 1100 : 1800)
    var ph = (now_ms() % period) * 4 / period
    var dy = ph == 0 ? 0 : (ph == 2 ? 2 : 1)
    var a = self.arch
    var i = 0
    while i < 182
      if a[i] != 0 pixel(i % 14, dy + i / 14, a[i]) end
      i += 1
    end
    var sc = [0x2E7D52, 0x8A7400, 0x8A1A14, 0x404850]
    var sw = 10 - (2 - dy) * 2
    rect_fill(7 - sw / 2, 15, sw, 1, sc[mo])
    if k == "G"
      self.mark(self.gem, true, 0)
    elif k == "C"
      self.mark(self.claude, false, 0xD97757)
    elif size(k) > 0
      font("large")
      text(15, 11, k, 0xD0D8E0)
      font("small")
    end
  end

  # 7x7 mark at x=15..21, y=4..10; each row is a 7-bit mask, MSB on the left
  def mark(rows, gradient, col)
    var y = 0
    while y < 7
      var x = 0
      while x < 7
        if (rows[y] >> (6 - x)) & 1
          var c = col
          if gradient
            # Gemini blue to purple along the diagonal
            var t = x + y
            c = ((0x4F + (0xA8 - 0x4F) * t / 12) << 16) | ((0x8D + (0x7B - 0x8D) * t / 12) << 8) | (0xF7 + (0xE8 - 0xF7) * t / 12)
          end
          pixel(15 + x, 4 + y, c)
        end
        x += 1
      end
      y += 1
    end
  end
end
return AntigravityQuota()
