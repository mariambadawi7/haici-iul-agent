const http = require("http");
const options = {
  hostname: "localhost",
  port: 5173,
  path: "/stt/v1/models",
  method: "GET"
};
const req = http.request(options, (res) => {
  console.log("STATUS:", res.statusCode);
});
req.on("error", (e) => {
  console.error("ERROR:", e.message);
});
req.end();
