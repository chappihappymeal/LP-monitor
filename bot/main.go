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
	"bytes"
	"context"
	"fmt"
	"image/png"
	"log"
	"net"
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
	return c, nil
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
	caption := "Открытые позиции · " + time.Now().Format("02.01 15:04")
	file := tgbotapi.FileBytes{Name: "positions.png", Bytes: png}

	// Telegram сжимает и ограничивает «фото» (сумма сторон ≤ 10000, соотношение
	// ≤ 20) — длинный ретина-скрин уходит документом в полном качестве.
	if w, h, ok := pngSize(png); ok && (w+h > 9500 || h > w*19) {
		doc := tgbotapi.NewDocument(chatID, file)
		doc.Caption = caption
		send(bot, doc)
		return
	}
	photo := tgbotapi.NewPhoto(chatID, file)
	photo.Caption = caption
	if _, err := bot.Send(photo); err != nil {
		// не влезло в лимиты фото — шлём документом
		doc := tgbotapi.NewDocument(chatID, file)
		doc.Caption = caption
		send(bot, doc)
	}
}

func pngSize(data []byte) (w, h int, ok bool) {
	c, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, false
	}
	return c.Width, c.Height, true
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
		chromedp.Sleep(5*time.Second), // свечным графикам нужно время на отрисовку
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
