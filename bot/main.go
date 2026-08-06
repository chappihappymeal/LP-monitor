// LP-monitor Telegram bot: по кнопке присылает скриншот вкладки «Позиции»
// (страница рендерится в headless chrome, сервис chrome в docker-compose).
//
// Конфигурация через env:
//
//	BOT_TOKEN     — токен бота (обязателен, в репозиторий не попадает);
//	ALLOWED_TG_ID — единственный разрешённый Telegram ID (по умолчанию 496639212);
//	WALLET        — кошелёк, чьи позиции показываем (обязателен);
//	APP_URL       — адрес веб-приложения (по умолчанию http://app:3000);
//	CHROME_WS     — DevTools-адрес headless chrome (по умолчанию ws://chrome:9222).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"

	"github.com/chromedp/chromedp"
	tgbotapi "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

const btnStats = "📊 Показать статистику"

type config struct {
	token     string
	allowedID int64
	wallet    string
	appURL    string
	chromeWS  string
	// Алерты о резких движениях цены:
	product    string        // продукт Coinbase (ALERT_PRODUCT, SOL-USD)
	fastPct    float64       // порог за 5 минут, % (ALERT_FAST_PCT, 1.5)
	hourPct    float64       // порог за час, % (ALERT_HOUR_PCT, 4)
	poll       time.Duration // период опроса (ALERT_POLL_SEC, 60с)
	cooldown   time.Duration // пауза между алертами одного типа (ALERT_COOLDOWN_MIN, 30м)
	reportHour int           // час ежедневного отчёта о fee (REPORT_HOUR, 10; TZ контейнера)
	// Позиционный алерт «цена у края диапазона»:
	edgePct       float64       // порог, % пути по диапазону (RANGE_EDGE_PCT, 75)
	rangePoll     time.Duration // период опроса позиций (RANGE_POLL_MIN, 5м)
	rangeCooldown time.Duration // повтор в той же зоне (RANGE_COOLDOWN_MIN, 120м)
}

func loadConfig() (config, error) {
	c := config{
		token:     os.Getenv("BOT_TOKEN"),
		wallet:    os.Getenv("WALLET"),
		appURL:    envOr("APP_URL", "http://app:3000"),
		chromeWS:  envOr("CHROME_WS", "ws://chrome:9222"),
		allowedID: 496639212,
	}
	if c.token == "" {
		return c, fmt.Errorf("не задан BOT_TOKEN")
	}
	if c.wallet == "" {
		return c, fmt.Errorf("не задан WALLET")
	}
	if v := os.Getenv("ALLOWED_TG_ID"); v != "" {
		id, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return c, fmt.Errorf("некорректный ALLOWED_TG_ID: %w", err)
		}
		c.allowedID = id
	}
	c.product = envOr("ALERT_PRODUCT", "SOL-USD")
	c.fastPct = envFloat("ALERT_FAST_PCT", 1.5)
	c.hourPct = envFloat("ALERT_HOUR_PCT", 4)
	c.poll = time.Duration(envFloat("ALERT_POLL_SEC", 60) * float64(time.Second))
	c.cooldown = time.Duration(envFloat("ALERT_COOLDOWN_MIN", 30) * float64(time.Minute))
	c.reportHour = int(envFloat("REPORT_HOUR", 10))
	c.edgePct = envFloat("RANGE_EDGE_PCT", 75)
	c.rangePoll = time.Duration(envFloat("RANGE_POLL_MIN", 5) * float64(time.Minute))
	c.rangeCooldown = time.Duration(envFloat("RANGE_COOLDOWN_MIN", 120) * float64(time.Minute))
	return c, nil
}

func envFloat(key string, def float64) float64 {
	if v := os.Getenv(key); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil {
			return f
		}
	}
	return def
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}

	bot, err := tgbotapi.NewBotAPI(cfg.token)
	if err != nil {
		log.Fatalf("telegram: %v", err)
	}
	log.Printf("бот %s запущен, разрешён TG ID %d", bot.Self.UserName, cfg.allowedID)

	// SELFTEST=1: одноразовая проверка всей цепочки (страница → chrome →
	// скриншот → фото в чат) без нажатия кнопки. Запуск:
	//   docker compose run --rm -e SELFTEST=1 bot
	if os.Getenv("SELFTEST") == "1" {
		log.Print("selftest: снимаю скриншот…")
		handleStats(bot, cfg.allowedID, cfg)
		log.Print("selftest: завершён")
		return
	}

	go priceWatcher(bot, cfg)
	go dailyFeeReporter(bot, cfg)
	go rangeWatcher(bot, cfg)

	u := tgbotapi.NewUpdate(0)
	u.Timeout = 30
	for update := range bot.GetUpdatesChan(u) {
		msg := update.Message
		if msg == nil {
			continue
		}
		if msg.From == nil || msg.From.ID != cfg.allowedID {
			log.Printf("отклонён запрос от TG ID %d", msg.From.ID)
			continue
		}
		switch msg.Text {
		case "/start":
			reply := tgbotapi.NewMessage(msg.Chat.ID, "LP-monitor на связи. Жми кнопку.")
			reply.ReplyMarkup = tgbotapi.NewReplyKeyboard(
				tgbotapi.NewKeyboardButtonRow(tgbotapi.NewKeyboardButton(btnStats)),
			)
			send(bot, reply)
		case btnStats, "/stats":
			handleStats(bot, msg.Chat.ID, cfg)
		}
	}
}

func handleStats(bot *tgbotapi.BotAPI, chatID int64, cfg config) {
	note := tgbotapi.NewMessage(chatID, "⏳ Собираю статистику (до минуты на публичном RPC)…")
	sent, _ := bot.Send(note)

	png, err := screenshotPositions(cfg)
	if sent.MessageID != 0 {
		_, _ = bot.Request(tgbotapi.NewDeleteMessage(chatID, sent.MessageID))
	}
	if err != nil {
		send(bot, tgbotapi.NewMessage(chatID, "Не получилось: "+err.Error()))
		return
	}
	// Всегда документом: «фото» Telegram пережимает до каши.
	doc := tgbotapi.NewDocument(chatID, tgbotapi.FileBytes{Name: "positions.png", Bytes: png})
	doc.Caption = "Открытые позиции · " + time.Now().Format("02.01 15:04")
	send(bot, doc)
}

// Скриншот вкладки «Позиции»: ждём появления карточек (или ошибки), даём
// графикам дорисоваться и снимаем всю страницу.
func screenshotPositions(cfg config) ([]byte, error) {
	allocCtx, cancelAlloc := chromedp.NewRemoteAllocator(context.Background(), cfg.chromeWS)
	defer cancelAlloc()
	ctx, cancelCtx := chromedp.NewContext(allocCtx)
	defer cancelCtx()
	ctx, cancelTimeout := context.WithTimeout(ctx, 3*time.Minute)
	defer cancelTimeout()

	// Хостнейм резолвим в IP: URL с IP-литералом Chrome не апгрейдит до
	// https (авто-апгрейд http→https ломался об ERR_SSL_PROTOCOL_ERROR).
	pageURL := cfg.appURL + "/?wallet=" + cfg.wallet
	if u, err := url.Parse(cfg.appURL); err == nil {
		host := u.Hostname()
		if net.ParseIP(host) == nil {
			if addrs, err := net.LookupHost(host); err == nil && len(addrs) > 0 {
				pageURL = fmt.Sprintf("%s://%s/?wallet=%s",
					u.Scheme, net.JoinHostPort(addrs[0], u.Port()), cfg.wallet)
			}
		}
	}
	var buf []byte
	err := chromedp.Run(ctx,
		// Мобильная вёрстка (узкий экран → карточки в колонку) в ретине ×2.
		chromedp.EmulateViewport(480, 900, chromedp.EmulateScale(2)),
		chromedp.Navigate(pageURL),
		chromedp.Poll(
			`document.querySelector('#out .card, #out .err') !== null`,
			nil,
			chromedp.WithPollingTimeout(150*time.Second),
			chromedp.WithPollingInterval(time.Second),
		),
		chromedp.Sleep(5*time.Second),      // свечным графикам нужно время на отрисовку
		chromedp.FullScreenshot(&buf, 100), // 100 → PNG без потерь
	)
	if err != nil {
		return nil, fmt.Errorf("скриншот: %w", err)
	}
	return buf, nil
}

func send(bot *tgbotapi.BotAPI, c tgbotapi.Chattable) {
	if _, err := bot.Send(c); err != nil {
		log.Printf("send: %v", err)
	}
}

// ── Алерты о резких движениях цены ──────────────────────────────────────────

type pricePoint struct {
	t time.Time
	p float64
}

// Опрос спот-цены раз в poll; алерт при |Δ| ≥ fastPct за 5 минут или
// |Δ| ≥ hourPct за час, с кулдауном на каждый тип. Если истории меньше
// окна — сравниваем с самой старой точкой (движение за меньший срок ещё
// аномальнее).
func priceWatcher(bot *tgbotapi.BotAPI, cfg config) {
	log.Printf("монитор цены %s: >%.1f%%/5мин или >%.1f%%/час, опрос %s",
		cfg.product, cfg.fastPct, cfg.hourPct, cfg.poll)
	var hist []pricePoint
	lastAlert := map[string]time.Time{}

	for ; ; time.Sleep(cfg.poll) {
		p, err := fetchSpot(cfg.product)
		if err != nil {
			log.Printf("монитор цены: %v", err)
			continue
		}
		now := time.Now()
		hist = append(hist, pricePoint{now, p})
		for len(hist) > 0 && now.Sub(hist[0].t) > 65*time.Minute {
			hist = hist[1:]
		}
		if len(hist) < 2 {
			continue
		}
		check := func(window time.Duration, thr float64, key, label string) {
			ref := hist[0]
			for _, h := range hist {
				if now.Sub(h.t) <= window {
					ref = h
					break
				}
			}
			if now.Sub(ref.t) < cfg.poll {
				return // сравнивать не с чем
			}
			ch := (p/ref.p - 1) * 100
			if math.Abs(ch) < thr || now.Sub(lastAlert[key]) < cfg.cooldown {
				return
			}
			lastAlert[key] = now
			emoji, dir := "🚀", "вверх"
			if ch < 0 {
				emoji, dir = "🚨", "вниз"
			}
			send(bot, tgbotapi.NewMessage(cfg.allowedID, fmt.Sprintf(
				"%s SOL резко идёт %s: %+.1f%% за %s ($%.2f → $%.2f).\nЖми «%s» — посмотрим позиции.",
				emoji, dir, ch, label, ref.p, p, btnStats)))
		}
		check(5*time.Minute, cfg.fastPct, "fast", "5 мин")
		check(60*time.Minute, cfg.hourPct, "hour", "час")
	}
}

// ── Ежедневный отчёт о fee ──────────────────────────────────────────────────

type feeEntry struct {
	PendingUsd  float64  `json:"pendingUsd"`
	EstDailyUsd float64  `json:"estDailyUsd"`
	EarnedUsd   *float64 `json:"earnedUsd"`
	Rebalanced  bool     `json:"rebalanced"`
}

// Каждый день в cfg.reportHour (по TZ контейнера) запрашивает у сервера замер
// fee (он же пишется в data/feelog — сырьё для будущего графика) и шлёт итог.
func dailyFeeReporter(bot *tgbotapi.BotAPI, cfg config) {
	log.Printf("ежедневный отчёт о fee: %02d:00 (%s)", cfg.reportHour, time.Now().Format("MST"))
	for {
		now := time.Now()
		next := time.Date(now.Year(), now.Month(), now.Day(), cfg.reportHour, 0, 0, 0, now.Location())
		if !next.After(now) {
			next = next.Add(24 * time.Hour)
		}
		time.Sleep(time.Until(next))

		var e feeEntry
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			if e, err = fetchFeeReport(cfg); err == nil {
				break
			}
			time.Sleep(2 * time.Minute)
		}
		if err != nil {
			send(bot, tgbotapi.NewMessage(cfg.allowedID, "⚠️ Утренний отчёт о fee не собрался: "+err.Error()))
			continue
		}
		var msg string
		if e.EarnedUsd == nil {
			msg = fmt.Sprintf("💰 Первый замер fee: pending $%.4f, расчётный темп $%.2f/день. Завтра будет дельта за сутки.",
				e.PendingUsd, e.EstDailyUsd)
		} else {
			msg = fmt.Sprintf("💰 Fee за последние 24ч: $%.4f\nPending сейчас: $%.4f · расчётный темп: $%.2f/день",
				*e.EarnedUsd, e.PendingUsd, e.EstDailyUsd)
			if e.Rebalanced {
				msg += "\n⚠️ Был ребаланс — pending обнулялся, цифра занижена."
			}
		}
		send(bot, tgbotapi.NewMessage(cfg.allowedID, msg))
	}
}

func fetchFeeReport(cfg config) (feeEntry, error) {
	var e feeEntry
	client := &http.Client{Timeout: 3 * time.Minute}
	resp, err := client.Get(cfg.appURL + "/api/feereport?wallet=" + cfg.wallet)
	if err != nil {
		return e, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return e, fmt.Errorf("feereport %d", resp.StatusCode)
	}
	return e, json.NewDecoder(resp.Body).Decode(&e)
}

// ── Позиционный алерт: цена у края диапазона ────────────────────────────────

type rangePos struct {
	PositionAddress string  `json:"positionAddress"`
	Pair            string  `json:"pair"`
	Lower           float64 `json:"lower"`
	Upper           float64 `json:"upper"`
	Price           float64 `json:"price"`
}

type zoneState struct {
	zone string
	at   time.Time
}

// Каждые rangePoll проверяет, где цена внутри диапазона каждой позиции.
// Пробитие edgePct (вверх) или 100−edgePct (вниз) — алерт; повтор в той же
// зоне не чаще rangeCooldown, возврат в середину сбрасывает состояние.
func rangeWatcher(bot *tgbotapi.BotAPI, cfg config) {
	log.Printf("монитор диапазона: края %d%%/%d%%, опрос %s",
		int(100-cfg.edgePct), int(cfg.edgePct), cfg.rangePoll)
	state := map[string]zoneState{}

	for ; ; time.Sleep(cfg.rangePoll) {
		var resp struct {
			Positions []rangePos `json:"positions"`
		}
		client := &http.Client{Timeout: 3 * time.Minute}
		r, err := client.Get(cfg.appURL + "/api/rangestatus?wallet=" + cfg.wallet)
		if err != nil {
			log.Printf("монитор диапазона: %v", err)
			continue
		}
		if r.StatusCode != 200 {
			r.Body.Close()
			log.Printf("монитор диапазона: HTTP %d", r.StatusCode)
			continue
		}
		err = json.NewDecoder(r.Body).Decode(&resp)
		r.Body.Close()
		if err != nil {
			log.Printf("монитор диапазона: %v", err)
			continue
		}

		for _, p := range resp.Positions {
			if p.Upper <= p.Lower {
				continue
			}
			pct := (p.Price - p.Lower) / (p.Upper - p.Lower) * 100
			zone := "mid"
			if pct >= cfg.edgePct {
				zone = "upper"
			} else if pct <= 100-cfg.edgePct {
				zone = "lower"
			}
			prev := state[p.PositionAddress]
			if zone == "mid" {
				state[p.PositionAddress] = zoneState{zone: "mid"}
				continue
			}
			if prev.zone == zone && time.Since(prev.at) < cfg.rangeCooldown {
				continue
			}
			state[p.PositionAddress] = zoneState{zone: zone, at: time.Now()}
			var txt string
			if zone == "upper" {
				txt = fmt.Sprintf("⚠️ %s: цена $%.2f прошла %.0f%% диапазона %.2f–%.2f (до верхней границы %+.1f%%).",
					p.Pair, p.Price, pct, p.Lower, p.Upper, (p.Upper/p.Price-1)*100)
			} else {
				txt = fmt.Sprintf("⚠️ %s: цена $%.2f опустилась к %.0f%% диапазона %.2f–%.2f (до нижней границы %+.1f%%).",
					p.Pair, p.Price, pct, p.Lower, p.Upper, (p.Lower/p.Price-1)*100)
			}
			send(bot, tgbotapi.NewMessage(cfg.allowedID,
				txt+"\nПора думать, что делать — жми «"+btnStats+"»."))
		}
	}
}

func fetchSpot(product string) (float64, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	req, _ := http.NewRequest("GET",
		"https://api.exchange.coinbase.com/products/"+product+"/ticker", nil)
	req.Header.Set("User-Agent", "lp-monitor-bot")
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return 0, fmt.Errorf("coinbase %d", resp.StatusCode)
	}
	var v struct {
		Price string `json:"price"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&v); err != nil {
		return 0, err
	}
	return strconv.ParseFloat(v.Price, 64)
}
