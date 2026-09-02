package mspace

// mSpace API client — Go port of templates/typescript/mspace-client.ts.
//
// One post() helper injects credentials, applies a timeout, and turns
// unsuccessful responses into typed errors. Every service is a thin wrapper
// that resolves its endpoint through Config.RequireEndpoint — so calling an API
// your application was not provisioned for fails locally with a clear message,
// rather than as E1309 from the platform.
//
// The one thing that is NOT global: success. "S1000" is the default, CaaS OTP
// generation succeeds with "P1003", and Subscriber List also accepts "S1001".
//
// Standard library only. SERVER-SIDE ONLY.

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// timeout is a protocol constant, not configuration: a single outbound call
// should never hang.
const timeout = 15 * time.Second

// transient codes are platform-side. Worth retrying with backoff.
var transient = map[string]bool{
	"E1100": true, "E1105": true, "E1300": true, "E1316": true, "E1318": true,
	"E1319": true, "E1341": true, "E1601": true, "E1603": true, "E1857": true,
	"E9999": true,
}

// configuration codes mean provisioning or credentials are wrong. Retrying will
// never help.
var configuration = map[string]bool{
	"E1102": true, "E1104": true, "E1301": true, "E1302": true, "E1303": true,
	"E1309": true, "E1311": true, "E1313": true, "E1315": true, "E1329": true,
	"E1330": true, "E1331": true, "E1371": true, "E1604": true, "E1607": true,
	"E1608": true,
}

// Success codes that are NOT S1000.
//
// P1003 is the documented success of CaaS OTP generation — the OTP went out,
// nothing is charged yet. S1001 means Subscriber List worked and matched
// nobody. A client that only accepts S1000 reports both as failures.
var (
	SuccessDefault           = []string{"S1000"}
	SuccessCaasOtpGeneration = []string{"P1003"}
	SuccessSubscriberList    = []string{"S1000", "S1001"}
)

// Error is an unsuccessful application-level response.
type Error struct {
	StatusCode   string
	StatusDetail string
	Service      string
	Raw          map[string]any
}

func (e *Error) Error() string {
	return fmt.Sprintf("[%s] %s (%s)", e.StatusCode, e.StatusDetail, e.Service)
}

// Retryable reports whether a backoff retry is appropriate.
func (e *Error) Retryable() bool { return transient[e.StatusCode] }

// IsConfiguration reports a provisioning or credential fault. Page on these.
func (e *Error) IsConfiguration() bool { return configuration[e.StatusCode] }

// Client is safe for concurrent use. Build one at startup and share it.
type Client struct {
	config *Config
	http   *http.Client
}

// NewClient builds a client over the given config.
//
// If an mSpace host serves an incomplete certificate chain, Go rejects it.
// Do NOT set InsecureSkipVerify — that lets anyone on the path read the
// applicationId and password that can charge your subscribers. Supply the
// intermediate CA instead:
//
//	pool := x509.NewCertPool()
//	pem, _ := os.ReadFile("certs/mspace-chain.pem")
//	pool.AppendCertsFromPEM(pem)
//	transport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}
//
// See references/09-security-best-practices.md.
func NewClient(config *Config) *Client {
	return &Client{config: config, http: &http.Client{Timeout: timeout}}
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

var separators = regexp.MustCompile(`[\s()\-]`)

// ToTelAddress normalises a subscriber address. The ONLY place "tel:" is added.
//
// Accepts an already-prefixed address, a masked value, +94…, 0094… or a local
// 07… number.
//
// Do NOT push an SMS sourceAddress through this — that is a sender alias or
// short code, not a subscriber address.
func ToTelAddress(msisdn string) (string, error) {
	trimmed := strings.TrimSpace(msisdn)
	if trimmed == "" {
		return "", fmt.Errorf("[mspace] empty subscriber address")
	}
	if strings.HasPrefix(strings.ToLower(trimmed), "tel:") {
		return trimmed, nil
	}
	digits := strings.TrimPrefix(separators.ReplaceAllString(trimmed, ""), "+")
	digits = strings.TrimPrefix(digits, "00")
	if strings.HasPrefix(digits, "0") && len(digits) == 10 {
		digits = "94" + digits[1:]
	}
	return "tel:" + digits, nil
}

// MaskAddress masks a subscriber address for logging. Never log the raw value.
func MaskAddress(address string) string {
	body := address
	if len(body) >= 4 && strings.EqualFold(body[:4], "tel:") {
		body = body[4:]
	}
	if len(body) <= 6 {
		return "tel:***"
	}
	return "tel:" + body[:3] + strings.Repeat("*", len(body)-6) + body[len(body)-3:]
}

// GenerateExternalTrxID returns a unique, persistable idempotency key for a
// charge. mSpace publishes no length limit, so this is simply a value that will
// never collide. Persist it BEFORE the charge call.
func GenerateExternalTrxID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

// DetailOf returns the human-readable message, wherever mSpace put it.
//
// Every service uses statusDetail except CaaS OTP verification, which uses
// statusDescription.
func DetailOf(data map[string]any) string {
	if detail, ok := data["statusDetail"].(string); ok && detail != "" {
		return detail
	}
	description, _ := data["statusDescription"].(string)
	return description
}

// FormatNotifyTimestamp renders yyMMddHHmm, the documented timestamp format for
// subscriber notifications.
func FormatNotifyTimestamp(moment time.Time) string {
	return moment.UTC().Format("0601021504")
}

/* ── Core ────────────────────────────────────────────────────────────────── */

func (c *Client) post(
	ctx context.Context,
	service, url string,
	body map[string]any,
	successCodes []string,
) (map[string]any, error) {
	if len(successCodes) == 0 {
		successCodes = SuccessDefault
	}
	payload := map[string]any{
		"applicationId": c.config.ApplicationID,
		"password":      c.config.Password,
	}
	for key, value := range body {
		payload[key] = value
	}

	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("[mspace] %s: encoding payload: %w", service, err)
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		return nil, fmt.Errorf("[mspace] %s: building request: %w", service, err)
	}
	request.Header.Set("Content-Type", "application/json;charset=utf-8")

	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("[mspace] %s: transport failure: %w", service, err)
	}
	defer response.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("[mspace] %s: reading response: %w", service, err)
	}

	// response.StatusCode is deliberately not consulted: mSpace returns 200 for
	// application-level failures, and the real outcome is statusCode in the body.
	var data map[string]any
	if err := json.Unmarshal(raw, &data); err != nil {
		limit := len(raw)
		if limit > 200 {
			limit = 200
		}
		return nil, fmt.Errorf("[mspace] %s: non-JSON response: %s", service, raw[:limit])
	}

	statusCode, _ := data["statusCode"].(string)
	for _, code := range successCodes {
		if statusCode == code {
			return data, nil
		}
	}
	return nil, &Error{
		StatusCode:   statusCode,
		StatusDetail: DetailOf(data),
		Service:      service,
		Raw:          data,
	}
}

/* ── SMS ─────────────────────────────────────────────────────────────────── */

// SendSMS sends an MT SMS to one or more subscribers.
func (c *Client) SendSMS(ctx context.Context, to []string, message string) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("smsSend")
	if err != nil {
		return nil, err
	}
	recipients := make([]string, 0, len(to))
	for _, raw := range to {
		address, err := ToTelAddress(raw)
		if err != nil {
			return nil, err
		}
		if address == "tel:all" {
			return nil, fmt.Errorf(
				"[mspace] use BroadcastSMS for tel:all — broadcasts must be deliberate")
		}
		recipients = append(recipients, address)
	}
	return c.post(ctx, "sms-send", url, map[string]any{
		"version":              "1.0",
		"message":              message,
		"destinationAddresses": recipients,
	}, nil)
}

// BroadcastConfirmation must be passed verbatim to BroadcastSMS.
const BroadcastConfirmation = "I_HAVE_VERIFIED_THIS_GOES_TO_ALL_SUBSCRIBERS"

// BroadcastSMS sends to the ENTIRE subscribed base of the application.
//
// Deliberately separate from SendSMS so it can never be reached by accident —
// check the subscriber base size first, and put an authorisation check in front
// of this.
func (c *Client) BroadcastSMS(
	ctx context.Context, message, confirmation string,
) (map[string]any, error) {
	if confirmation != BroadcastConfirmation {
		return nil, fmt.Errorf("[mspace] broadcast confirmation token missing")
	}
	url, err := c.config.RequireEndpoint("smsSend")
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "sms-send", url, map[string]any{
		"version":              "1.0",
		"message":              message,
		"destinationAddresses": []string{"tel:all"},
	}, nil)
}

/* ── USSD ────────────────────────────────────────────────────────────────── */

// SendUSSD sends a USSD screen.
//
// sessionID MUST be the one the USSD Gateway sent you. Use "mt-fin" for the
// final screen — anything else leaves the session hanging until the network
// times out.
func (c *Client) SendUSSD(
	ctx context.Context, sessionID, destinationAddress, message, operation string,
) (map[string]any, error) {
	switch operation {
	case "mt-init", "mt-cont", "mt-fin":
	default:
		return nil, fmt.Errorf("[mspace] invalid ussdOperation %q", operation)
	}
	url, err := c.config.RequireEndpoint("ussdSend")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(destinationAddress)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "ussd-send", url, map[string]any{
		"version":            "1.0",
		"message":            message,
		"sessionId":          sessionID,
		"ussdOperation":      operation,
		"destinationAddress": address,
		"encoding":           "440",
	}, nil)
}

/* ── Subscription ────────────────────────────────────────────────────────── */

// Register opts a subscriber in. Only call this with recorded, explicit consent.
func (c *Client) Register(ctx context.Context, subscriberID string) (map[string]any, error) {
	return c.subscription(ctx, "subscription-register", subscriberID, "1")
}

// Unregister opts a subscriber out. Make it as reachable as Register, in every
// channel the subscriber has.
func (c *Client) Unregister(ctx context.Context, subscriberID string) (map[string]any, error) {
	return c.subscription(ctx, "subscription-unregister", subscriberID, "0")
}

func (c *Client) subscription(
	ctx context.Context, service, subscriberID, action string,
) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("subscriptionSend")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, service, url, map[string]any{
		"subscriberId": address,
		"action":       action,
	}, nil)
}

// SubscriptionStatus checks one subscriber. For reconciliation, not per-request
// gating — mirror the subscription notification callback instead.
//
// The result is one of six statuses, not two: INITIAL, REG_PENDING, TRIAL,
// REGISTERED, UNREGISTERED, TEMPORARY_BLOCKED.
func (c *Client) SubscriptionStatus(
	ctx context.Context, subscriberID string,
) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("subscriptionStatus")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "subscription-status", url, map[string]any{"subscriberId": address}, nil)
}

// QueryBase returns the subscriber base size. It needs no subscriber and charges
// nothing, which also makes it the best connectivity and credential smoke test.
func (c *Client) QueryBase(ctx context.Context) (int64, error) {
	url, err := c.config.RequireEndpoint("subscriptionQueryBase")
	if err != nil {
		return 0, err
	}
	data, err := c.post(ctx, "subscription-query-base", url, map[string]any{}, nil)
	if err != nil {
		return 0, err
	}
	size, _ := data["baseSize"].(string) // documented as a string
	parsed, err := strconv.ParseInt(size, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("[mspace] unexpected baseSize %q", size)
	}
	return parsed, nil
}

// SubscriberChargingInfo returns subscription status and last-charge details for
// up to ten subscribers.
//
// Every entry in destinationResponses carries its own statusCode — one
// subscriber failing does not fail the request — and which fields are present
// depends on the status.
func (c *Client) SubscriberChargingInfo(
	ctx context.Context, subscriberIDs []string,
) (map[string]any, error) {
	if len(subscriberIDs) > 10 {
		return nil, fmt.Errorf("[mspace] SubscriberChargingInfo accepts at most 10 subscriberIds")
	}
	url, err := c.config.RequireEndpoint("subscriptionChargingInfo")
	if err != nil {
		return nil, err
	}
	addresses := make([]string, 0, len(subscriberIDs))
	for _, raw := range subscriberIDs {
		address, err := ToTelAddress(raw)
		if err != nil {
			return nil, err
		}
		addresses = append(addresses, address)
	}
	return c.post(ctx, "subscription-charging-info", url, map[string]any{
		"subscriberIds": addresses,
	}, nil)
}

// SubscriberList returns one page of the subscriber list — the catch-up
// mechanism for subscription notifications you missed.
//
// S1001 ("No Subscribers Found") is a SUCCESS: the request worked and matched
// nobody. Page until moreDataAvailable is false; nextPageNumber is -1 when there
// is no next page.
func (c *Client) SubscriberList(ctx context.Context, requestPage int) (map[string]any, error) {
	if requestPage < 1 {
		return nil, fmt.Errorf("[mspace] requestPage must be 1 or greater (E1106)")
	}
	url, err := c.config.RequireEndpoint("subscriptionList")
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "subscription-list", url, map[string]any{
		"version":     "1.0",
		"requestPage": requestPage,
	}, SuccessSubscriberList)
}

// NotifySubscriber sends a subscription notification to a subscriber.
func (c *Client) NotifySubscriber(
	ctx context.Context, subscriberID, frequency, status, timeStamp string,
) (map[string]any, error) {
	switch frequency {
	case "daily", "weekly", "monthly", "yearly":
	default:
		return nil, fmt.Errorf("[mspace] invalid frequency %q", frequency)
	}
	url, err := c.config.RequireEndpoint("subscriptionNotify")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	if timeStamp == "" {
		timeStamp = FormatNotifyTimestamp(time.Now())
	}
	return c.post(ctx, "subscription-notify", url, map[string]any{
		"timeStamp":    timeStamp,
		"version":      "1.0",
		"subscriberId": address,
		"frequency":    frequency,
		"status":       status,
	}, nil)
}

/* ── OTP (subscription activation) ───────────────────────────────────────── */

// RequestOTP sends an OTP to a plain mobile number.
//
// Rate-limit per number AND per IP before calling, or the application becomes an
// SMS-bombing tool. Keep the returned referenceNo server-side; never log it.
func (c *Client) RequestOTP(
	ctx context.Context, subscriberID string, metaData map[string]any,
) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("otpRequest")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"subscriberId": address}
	if len(metaData) > 0 {
		body["applicationMetaData"] = metaData
	}
	return c.post(ctx, "otp-request", url, body, nil)
}

// VerifyOTP verifies an OTP and activates the subscription.
//
// mSpace does not publish the validity window or the attempt limit — E1851
// (expired) and E1852 (attempts reached) are what you get when either is hit, so
// enforce your own limits too. The returned subscriberId is the masked
// identifier to use for every subsequent call.
func (c *Client) VerifyOTP(ctx context.Context, referenceNo, otp string) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("otpVerify")
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "otp-verify", url, map[string]any{
		"referenceNo": referenceNo,
		"otp":         otp,
	}, nil)
}

/* ── CaaS ────────────────────────────────────────────────────────────────── */

// StartCharge is step 1 of a charge: generate and send the OTP.
//
// THIS STARTS A REAL CHARGE. It does not complete one.
//
//   - The success code is P1003, not S1000. Nothing is charged yet; mSpace has
//     SMSed an OTP to the subscriber.
//   - externalTrxID is your idempotency key. Generate it with
//     GenerateExternalTrxID, PERSIST IT, then call this.
//   - Persist requestCorrelator from the response — step 3 needs it — and
//     internalTrxId, which is what support traces with.
//   - There are deliberately no retries here. A timeout does NOT mean nothing
//     happened. Settle unknown outcomes from the charging notification.
//   - amount is a string: keep money in a decimal type (shopspring/decimal, or
//     integer minor units) and format it here. Never float64.
func (c *Client) StartCharge(
	ctx context.Context, subscriberID, amount, externalTrxID, currency string,
) (map[string]any, error) {
	if externalTrxID == "" {
		return nil, fmt.Errorf("[mspace] externalTrxId is required and must be persisted first")
	}
	url, err := c.config.RequireEndpoint("caasDebit")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	if currency == "" {
		currency = "LKR"
	}
	return c.post(ctx, "caas-otp-generation", url, map[string]any{
		"externalTrxId":         externalTrxID,
		"subscriberId":          address,
		"paymentInstrumentName": "Mobile Account",
		"amount":                amount,
		"currency":              currency,
	}, SuccessCaasOtpGeneration)
}

// ConfirmCharge is step 3 of a charge: verify the OTP the subscriber entered.
//
// THIS IS THE CALL THAT MOVES THE MONEY.
//
// requestCorrelator is the value returned by StartCharge, NOT your
// externalTrxId — sending the wrong one gives E1855. The response carries
// statusDescription rather than statusDetail, plus a boolean status.
//
// The final outcome still arrives on the charging notification.
func (c *Client) ConfirmCharge(
	ctx context.Context, requestCorrelator, otp, sourceAddress string,
) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("caasOtpVerify")
	if err != nil {
		return nil, err
	}
	address, err := ToTelAddress(sourceAddress)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, "caas-otp-verify", url, map[string]any{
		"referenceNo":   requestCorrelator,
		"otp":           otp,
		"sourceAddress": address,
	}, nil)
}

/* ── LBS ─────────────────────────────────────────────────────────────────── */

// RequestLocation requests a subscriber's location. mSpace returns it only if
// the subscriber has granted permission.
//
// requesterID (who is asking) and subscriberID (who is being located) are two
// different mandatory fields. Swapping them locates the wrong person.
//
// Requires explicit, purpose-specific consent — consent to receive SMS is not
// consent to be located.
func (c *Client) RequestLocation(
	ctx context.Context, requesterID, subscriberID, serviceType string,
) (map[string]any, error) {
	url, err := c.config.RequireEndpoint("lbsRequest")
	if err != nil {
		return nil, err
	}
	requester, err := ToTelAddress(requesterID)
	if err != nil {
		return nil, err
	}
	subscriber, err := ToTelAddress(subscriberID)
	if err != nil {
		return nil, err
	}
	body := map[string]any{"requesterId": requester, "subscriberId": subscriber}
	if serviceType != "" {
		body["serviceType"] = serviceType
	}
	return c.post(ctx, "lbs-request", url, body, nil)
}

/* ── Extension point ──────────────────────────────────────────────────────
 *
 * Adding a service mSpace publishes later:
 *
 *   1. Add its URL variable to .env.example and to endpointVars in config.go
 *   2. Add one wrapper here that calls c.post with the new endpoint key.
 *
 * It inherits credential injection, the timeout, error mapping and the
 * not-provisioned guard for free. Do not build a parallel client.
 */
