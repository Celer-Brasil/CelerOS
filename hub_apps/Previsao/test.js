// Wire de teste do Previsao (nunca vai ao aparelho): scripta a resposta do
// Open-Meteo para exercitar o caminho da rede (dias, acentos, cache).
// Usado por `node tools/sdk/celer.js test|emu hub_apps/Previsao`.
module.exports.wire = function (env) {
    env.Net.isConnected = function () { return true; };
    env.Net.getJSON = function (url) {
        return {
            current: { temperature_2m: 24.4, relative_humidity_2m: 60, weather_code: 3 },
            daily: {
                time: ["2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"],
                weather_code: [0, 61, 2, 95],
                temperature_2m_max: [27, 22, 25, 23],
                temperature_2m_min: [16, 15, 14, 17]
            }
        };
    };
};
