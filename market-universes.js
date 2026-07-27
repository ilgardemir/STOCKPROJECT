/* Additional screening universes.
 * Nasdaq-100 constituents were refreshed from Nasdaq's public list-type API
 * on 2026-07-24. Dow 30 reflects the 2026-06-29 Alphabet/Verizon change.
 * S&P 500 membership and names remain authoritative in sp500.js.
 */
window.MARKET_UNIVERSES = {
  "nasdaq100": [
    "AAPL", "AMAT", "AMGN", "CMCSA", "INTC", "KLAC", "PCAR", "CTAS", "PAYX", "LRCX",
    "ADSK", "ROST", "MNST", "MSFT", "ADBE", "FAST", "EA", "CSCO", "REGN", "IDXX",
    "VRTX", "ODFL", "QCOM", "GILD", "SNPS", "SBUX", "INTU", "MCHP", "ORLY", "COST",
    "CPRT", "ASML", "TTWO", "AMZN", "MSTR", "NVDA", "BKNG", "ISRG", "MRVL", "ADI",
    "AEP", "AMD", "ADP", "CDNS", "CSX", "HON", "MAR", "MU", "XEL", "EXC", "PEP",
    "ROP", "TER", "TXN", "WDC", "WMT", "AXON", "MDLZ", "NFLX", "STX", "ALNY",
    "GOOGL", "MPWR", "DXCM", "TMUS", "MELI", "KDP", "NBIS", "AVGO", "FTNT", "TSLA",
    "NXPI", "FANG", "META", "PANW", "WDAY", "GOOG", "PYPL", "SHOP", "KHC", "LITE",
    "CCEP", "BKR", "PDD", "CRWD", "DDOG", "RKLB", "PLTR", "ABNB", "DASH", "APP",
    "CEG", "WBD", "GEHC", "LIN", "ARM", "TRI", "FER", "ALAB", "SNDK", "CRWV",
    "SPCX", "HONA"
  ],
  "dow30": [
    "MMM", "AXP", "AMGN", "AMZN", "AAPL", "BA", "CAT", "CVX", "CSCO", "KO",
    "DIS", "GOOGL", "GS", "HD", "HON", "IBM", "JNJ", "JPM", "MCD", "MRK",
    "MSFT", "NKE", "NVDA", "PG", "CRM", "SHW", "TRV", "UNH", "V", "WMT"
  ],
  "names": {
    "AAPL":"Apple", "AMAT":"Applied Materials", "AMGN":"Amgen", "CMCSA":"Comcast",
    "INTC":"Intel", "KLAC":"KLA", "PCAR":"PACCAR", "CTAS":"Cintas", "PAYX":"Paychex",
    "LRCX":"Lam Research", "ADSK":"Autodesk", "ROST":"Ross Stores", "MNST":"Monster Beverage",
    "MSFT":"Microsoft", "ADBE":"Adobe", "FAST":"Fastenal", "EA":"Electronic Arts",
    "CSCO":"Cisco Systems", "REGN":"Regeneron Pharmaceuticals", "IDXX":"IDEXX Laboratories",
    "VRTX":"Vertex Pharmaceuticals", "ODFL":"Old Dominion Freight Line", "QCOM":"Qualcomm",
    "GILD":"Gilead Sciences", "SNPS":"Synopsys", "SBUX":"Starbucks", "INTU":"Intuit",
    "MCHP":"Microchip Technology", "ORLY":"O'Reilly Automotive", "COST":"Costco Wholesale",
    "CPRT":"Copart", "ASML":"ASML Holding", "TTWO":"Take-Two Interactive", "AMZN":"Amazon",
    "MSTR":"Strategy", "NVDA":"NVIDIA", "BKNG":"Booking Holdings", "ISRG":"Intuitive Surgical",
    "MRVL":"Marvell Technology", "ADI":"Analog Devices", "AEP":"American Electric Power",
    "AMD":"Advanced Micro Devices", "ADP":"Automatic Data Processing", "CDNS":"Cadence Design Systems",
    "CSX":"CSX", "HON":"Honeywell International", "MAR":"Marriott International",
    "MU":"Micron Technology", "XEL":"Xcel Energy", "EXC":"Exelon", "PEP":"PepsiCo",
    "ROP":"Roper Technologies", "TER":"Teradyne", "TXN":"Texas Instruments",
    "WDC":"Western Digital", "WMT":"Walmart", "AXON":"Axon Enterprise",
    "MDLZ":"Mondelez International", "NFLX":"Netflix", "STX":"Seagate Technology",
    "ALNY":"Alnylam Pharmaceuticals", "GOOGL":"Alphabet Class A", "MPWR":"Monolithic Power Systems",
    "DXCM":"DexCom", "TMUS":"T-Mobile US", "MELI":"MercadoLibre", "KDP":"Keurig Dr Pepper",
    "NBIS":"Nebius Group", "AVGO":"Broadcom", "FTNT":"Fortinet", "TSLA":"Tesla",
    "NXPI":"NXP Semiconductors", "FANG":"Diamondback Energy", "META":"Meta Platforms",
    "PANW":"Palo Alto Networks", "WDAY":"Workday", "GOOG":"Alphabet Class C",
    "PYPL":"PayPal", "SHOP":"Shopify", "KHC":"Kraft Heinz", "LITE":"Lumentum",
    "CCEP":"Coca-Cola Europacific Partners", "BKR":"Baker Hughes", "PDD":"PDD Holdings",
    "CRWD":"CrowdStrike", "DDOG":"Datadog", "RKLB":"Rocket Lab", "PLTR":"Palantir",
    "ABNB":"Airbnb", "DASH":"DoorDash", "APP":"AppLovin", "CEG":"Constellation Energy",
    "WBD":"Warner Bros. Discovery", "GEHC":"GE HealthCare", "LIN":"Linde",
    "ARM":"Arm Holdings", "TRI":"Thomson Reuters", "FER":"Ferrovial",
    "ALAB":"Astera Labs", "SNDK":"Sandisk", "CRWV":"CoreWeave",
    "SPCX":"Space Exploration Technologies", "HONA":"Honeywell Aerospace",
    "MMM":"3M", "AXP":"American Express", "BA":"Boeing", "CAT":"Caterpillar",
    "CVX":"Chevron", "KO":"Coca-Cola", "DIS":"Walt Disney", "GS":"Goldman Sachs",
    "HD":"Home Depot", "IBM":"IBM", "JNJ":"Johnson & Johnson", "JPM":"JPMorgan Chase",
    "MCD":"McDonald's", "MRK":"Merck", "NKE":"Nike", "PG":"Procter & Gamble",
    "CRM":"Salesforce", "SHW":"Sherwin-Williams", "TRV":"Travelers", "UNH":"UnitedHealth Group",
    "V":"Visa"
  }
};
