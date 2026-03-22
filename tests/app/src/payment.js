import http from "node:http";

const PAYMENT_API = process.env.PAYMENT_API_URL || "http://payments.example.com";

// Call external payment gateway — no retry logic (BUG: fails on transient errors)
export async function chargePayment(orderId, amount) {
  const body = JSON.stringify({ orderId, amount });
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${PAYMENT_API}/charge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`Payment failed: ${res.statusCode} ${data}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(new Error(`Payment network error: ${err.message}`)));
    req.end(body);
  });
}
