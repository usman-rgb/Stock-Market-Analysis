"""
Stock Market Trading Dashboard - Real-Time Edition
Uses yfinance for live market data + pre-trained XGBoost model
for AI-powered 1-Day, 5-Day, and 10-Day price predictions.
"""
from flask import Flask, render_template, jsonify
import pandas as pd
import numpy as np
import xgboost as xgb
import yfinance as yf
import joblib
import os, json, time, warnings, threading
from datetime import datetime, timedelta
warnings.filterwarnings('ignore')

def clean_nan(obj):
    """Recursively replace NaN/Inf floats with None for valid JSON."""
    if isinstance(obj, dict):
        return {k: clean_nan(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [clean_nan(v) for v in obj]
    elif isinstance(obj, float) and (np.isnan(obj) or np.isinf(obj)):
        return None
    return obj

app = Flask(__name__)
BASE = r'c:\Users\Usman\Desktop\Stock Market\Huge Stock Market'
CACHE = {}
LIVE_CACHE = {}          # ticker -> {data, timestamp}
LIVE_CACHE_TTL = 300     # 5 min cache - avoids hammering Yahoo Finance
QUOTE_CACHE = {}         # ticker -> {quote, timestamp}
QUOTE_CACHE_TTL = 120    # 2 min cache for quotes

#  Popular tickers for real-time tracking 
REALTIME_TICKERS = [
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'META', 'NVDA', 'AMD',
    'NFLX', 'DIS', 'BA', 'JPM', 'GS', 'V', 'MA', 'PYPL', 'SQ',
    'UBER', 'COIN', 'SHOP', 'CRM', 'ORCL', 'INTC', 'QCOM', 'AVGO',
    'SPY', 'QQQ', 'IWM', 'DIA', 'VTI', 'XLF', 'XLE', 'XLK', 'GLD',
    'BRK-B', 'JNJ', 'UNH', 'PG', 'HD', 'KO', 'PEP', 'WMT', 'COST',
    'ABNB', 'SNAP', 'PLTR', 'RIVN', 'SOFI', 'NIO', 'BABA'
]


def build_features_ticker(tdf):
    """Build all technical indicator features for a ticker dataframe."""
    c = tdf['Close']; v = tdf['Volume']
    for d in [1,2,3,5,10,20]: tdf[f'Ret_{d}d'] = c.pct_change(d)
    for w in [5,10,20,50,100]:
        tdf[f'SMA_{w}'] = c.rolling(w).mean()
        tdf[f'Pr_SMA_{w}'] = c / tdf[f'SMA_{w}']
    for w in [5,10,20,50]:
        tdf[f'EMA_{w}'] = c.ewm(span=w).mean()
        tdf[f'SMA_{w}_Slope'] = tdf[f'SMA_{w}'].pct_change(5)
    tdf['Cross_5_20']=(tdf['SMA_5']>tdf['SMA_20']).astype(int)
    tdf['Cross_10_50']=(tdf['SMA_10']>tdf['SMA_50']).astype(int)
    tdf['Cross_20_50']=(tdf['SMA_20']>tdf['SMA_50']).astype(int)
    tdf['Cross_20_100']=(tdf['SMA_20']>tdf['SMA_100']).astype(int)
    tdf['Cross_EMA_5_20']=(tdf['EMA_5']>tdf['EMA_20']).astype(int)
    tdf['Cross_EMA_10_50']=(tdf['EMA_10']>tdf['EMA_50']).astype(int)
    tdf['Trend_Align']=tdf['Cross_5_20']+tdf['Cross_10_50']+tdf['Cross_20_50']+tdf['Cross_20_100']
    def rsi(s,p=14):
        d=s.diff(); g=d.where(d>0,0).rolling(p).mean(); l=(-d.where(d<0,0)).rolling(p).mean()
        return 100-100/(1+g/(l+1e-10))
    tdf['RSI_7']=rsi(c,7); tdf['RSI_14']=rsi(c,14); tdf['RSI_21']=rsi(c,21)
    tdf['MACD']=tdf['EMA_10']-tdf['EMA_20']
    tdf['MACD_Sig']=tdf['MACD'].ewm(span=9).mean()
    tdf['MACD_Hist']=tdf['MACD']-tdf['MACD_Sig']
    tdf['MACD_Cross']=(tdf['MACD']>tdf['MACD_Sig']).astype(int)
    for w in [5,10,20]: tdf[f'Vol_{w}']=tdf['Ret_1d'].rolling(w).std()
    bb=c.rolling(20).std()
    tdf['BB_Width']=(4*bb)/(tdf['SMA_20']+1e-10)
    tdf['BB_Pos']=(c-(tdf['SMA_20']-2*bb))/(4*bb+1e-10)
    tdf['Vol_SMA10']=v.rolling(10).mean()
    tdf['Vol_Ratio']=v/(tdf['Vol_SMA10']+1)
    tdf['Vol_SMA20']=v.rolling(20).mean()
    tdf['Vol_Trend']=tdf['Vol_SMA10']/(tdf['Vol_SMA20']+1)
    tdf['Range']=(tdf['High']-tdf['Low'])/(c+1e-10)
    tdf['Body']=abs(c-tdf['Open'])/(c+1e-10)
    tdf['Upper_Wick']=(tdf['High']-tdf[['Open','Close']].max(axis=1))/(c+1e-10)
    tdf['Lower_Wick']=(tdf[['Open','Close']].min(axis=1)-tdf['Low'])/(c+1e-10)
    for lag in [1,2,3,5,10]:
        tdf[f'RetLag_{lag}']=tdf['Ret_1d'].shift(lag)
        tdf[f'VolLag_{lag}']=tdf['Vol_Ratio'].shift(lag)
    tdf['Ret_Mean_10']=tdf['Ret_1d'].rolling(10).mean()
    tdf['Ret_Mean_20']=tdf['Ret_1d'].rolling(20).mean()
    tdf['Ret_Skew_20']=tdf['Ret_1d'].rolling(20).skew()
    tdf['DayOfWeek']=tdf['Date'].dt.dayofweek
    tdf['Month']=tdf['Date'].dt.month
    tdf['Quarter']=tdf['Date'].dt.quarter
    return tdf


def fetch_live_data(ticker):
    """Fetch stock data using fast yf.download() - cached for 5 min."""
    now = time.time()
    
    # Check cache first
    if ticker in LIVE_CACHE:
        cached = LIVE_CACHE[ticker]
        if now - cached['timestamp'] < LIVE_CACHE_TTL:
            return cached['data']
    
    try:
        t0 = time.time()
        # yf.download() is MUCH faster than Ticker.history()
        hist = yf.download(ticker, period='3mo', interval='1d',
                           progress=False, auto_adjust=True, threads=False)
        
        if hist.empty or len(hist) < 50:
            return None
        
        hist = hist.reset_index()
        # Handle MultiIndex columns from yf.download
        if isinstance(hist.columns, pd.MultiIndex):
            hist.columns = [c[0] if c[1] == '' or c[1] == ticker else c[0] for c in hist.columns]
        hist.columns = [c.strip() for c in hist.columns]
        
        # Normalize column names
        rename_map = {}
        for col in hist.columns:
            cl = col.lower()
            if cl == 'date': rename_map[col] = 'Date'
            elif cl == 'open': rename_map[col] = 'Open'
            elif cl == 'high': rename_map[col] = 'High'
            elif cl == 'low': rename_map[col] = 'Low'
            elif cl == 'close': rename_map[col] = 'Close'
            elif cl == 'volume': rename_map[col] = 'Volume'
        hist = hist.rename(columns=rename_map)
        
        hist['Date'] = pd.to_datetime(hist['Date'])
        if hist['Date'].dt.tz is not None:
            hist['Date'] = hist['Date'].dt.tz_localize(None)
        
        hist['Ticker'] = ticker
        hist['Source'] = 2
        
        needed = ['Date','Open','High','Low','Close','Volume','Ticker','Source']
        for col in needed:
            if col not in hist.columns:
                return None
        hist = hist[needed].copy()
        hist = hist.sort_values('Date').reset_index(drop=True)
        hist = build_features_ticker(hist)
        
        for c_col in hist.select_dtypes(include=['float32','float64']).columns:
            hist[c_col] = hist[c_col].replace([np.inf,-np.inf], np.nan).fillna(0)
        
        LIVE_CACHE[ticker] = {'data': hist, 'timestamp': now}
        print(f"[>>] {ticker}: fetched {len(hist)} rows in {time.time()-t0:.1f}s")
        return hist
        
    except Exception as e:
        print(f"[!] Live fetch failed for {ticker}: {e}")
        return None


def get_realtime_quote(ticker):
    """Get real-time quote - cached for 2 min."""
    now = time.time()
    if ticker in QUOTE_CACHE:
        cached = QUOTE_CACHE[ticker]
        if now - cached['timestamp'] < QUOTE_CACHE_TTL:
            return cached['quote']
    try:
        tk = yf.Ticker(ticker)
        info = tk.fast_info
        quote = {
            'current_price': float(info.last_price) if hasattr(info, 'last_price') else None,
            'previous_close': float(info.previous_close) if hasattr(info, 'previous_close') else None,
            'market_cap': float(info.market_cap) if hasattr(info, 'market_cap') else None,
        }
        QUOTE_CACHE[ticker] = {'quote': quote, 'timestamp': now}
        return quote
    except:
        return None


def compute_forecasts(row, ai_prob):
    """Combine Technical Analysis with XGBoost Probability for 1/5/10 Day forecasts"""
    rsi = row.get('RSI_14', 50)
    macd_hist = row.get('MACD_Hist', 0)
    macd_cross = row.get('MACD_Cross', 0)
    trend = row.get('Trend_Align', 2)
    bb = row.get('BB_Pos', 0.5)
    
    # AI Factor (XGBoost predicts long-term bullishness)
    ai_factor = (ai_prob - 0.5) * 4 

    # --- 1-DAY FORECAST (Short term momentum) ---
    score_1d = ai_factor * 0.5
    if rsi < 30: score_1d += 3
    elif rsi > 70: score_1d -= 3
    if macd_hist > 0: score_1d += 2
    else: score_1d -= 2
    
    # --- 5-DAY FORECAST (Swing trade) ---
    score_5d = ai_factor * 1.5
    if rsi < 35: score_5d += 2
    elif rsi > 65: score_5d -= 2
    if macd_cross: score_5d += 2
    if trend >= 3: score_5d += 1
    elif trend <= 1: score_5d -= 1

    # --- 10-DAY FORECAST (Trend alignment) ---
    score_10d = ai_factor * 2.5
    if trend == 4: score_10d += 3
    elif trend == 0: score_10d -= 3
    if rsi < 40: score_10d += 1
    elif rsi > 60: score_10d -= 1

    def format_forecast(score, max_score):
        conf = min(abs(score) / max_score, 1.0) * 100
        direction = 'UP' if score > 0.5 else 'DOWN' if score < -0.5 else 'NEUTRAL'
        strength = 'Strong' if conf > 60 else 'Moderate' if conf > 30 else 'Weak'
        if direction == 'NEUTRAL': conf = 0; strength = 'None'
        return {'direction': direction, 'confidence': round(conf, 1), 'strength': strength}

    return {
        '1d': format_forecast(score_1d, 8),
        '5d': format_forecast(score_5d, 10),
        '10d': format_forecast(score_10d, 12)
    }


def load_resources():
    """Load AI model, scaler, and prepare startup data."""
    print("=" * 50)
    print("  StockTerminal Pro - Real-Time AI Engine")
    print("=" * 50)
    print("Loading AI Model, Scaler, and Data...")
    t0 = time.time()
    
    # 1. Load XGBoost Model
    model_path = os.path.join(BASE, 'xgboost_stock_model.json')
    scaler_path = os.path.join(BASE, 'scaler.pkl')
    features_path = os.path.join(BASE, 'features.json')
    
    if os.path.exists(model_path):
        CACHE['model'] = xgb.Booster(model_file=model_path)
        CACHE['scaler'] = joblib.load(scaler_path)
        with open(features_path) as f:
            CACHE['features'] = json.load(f)
        print("[OK] AI Components Loaded.")
    else:
        print("[!!] AI Model not found! Will run without ML.")
        CACHE['model'] = None

    # 2. Set available tickers (real-time tickers)
    CACHE['tickers'] = sorted(REALTIME_TICKERS)
    
    print(f"[OK] Ready! Total time: {time.time()-t0:.1f}s")
    print(f"[>>] Live tickers available: {len(CACHE['tickers'])}")
    print("=" * 50)
    print("[**] App is LIVE at http://localhost:5000")
    print("=" * 50)


@app.route('/')
def dashboard():
    return render_template('index.html', tickers=CACHE['tickers'])


@app.route('/api/predict/<ticker>')
def predict(ticker):
    """Main prediction endpoint - fetches live data and runs AI model."""
    ticker = ticker.upper()
    
    # Fetch live data (cached, fast)
    tdf = fetch_live_data(ticker)
    
    if tdf is None or len(tdf) < 30:
        return jsonify({'error': f'Could not fetch data for {ticker}. Check if ticker is valid.'}), 400

    recent = tdf.tail(60).copy()
    last = recent.iloc[-1]
    
    # ML Prediction
    ai_prob = 0.5
    if CACHE.get('model'):
        try:
            feats = CACHE['features']
            X = recent[feats].values.copy()
            X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0).astype('float32')
            X_scaled = CACHE['scaler'].transform(X)
            dm = xgb.DMatrix(X_scaled, feature_names=feats)
            probs = CACHE['model'].predict(dm)
            ai_prob = float(probs[-1])
        except Exception as e:
            print(f"[!] ML prediction error for {ticker}: {e}")
            ai_prob = 0.5

    forecasts = compute_forecasts(last.to_dict(), ai_prob)

    last_close = float(last['Close'])
    prev_close = float(recent['Close'].iloc[-2]) if len(recent) > 1 else last_close
    change = last_close - prev_close
    change_pct = (change / prev_close) * 100 if prev_close else 0

    # Use last close as current price (no extra API call = FAST)
    # Real-time quote is fetched separately via /api/quote endpoint
    current_price = round(last_close, 2)
    rt_change = round(change, 2)
    rt_change_pct = round(change_pct, 2)
    market_cap = None

    # Get last date in data
    last_date = last['Date']
    if isinstance(last_date, pd.Timestamp):
        last_date = last_date.strftime('%Y-%m-%d')
    else:
        last_date = str(last_date)[:10]

    #  Support & Resistance Levels 
    closes = recent['Close'].values
    highs = recent['High'].values
    lows = recent['Low'].values
    support_1 = round(float(np.min(lows[-20:])), 2)
    support_2 = round(float(np.percentile(lows[-40:], 10)), 2)
    resistance_1 = round(float(np.max(highs[-20:])), 2)
    resistance_2 = round(float(np.percentile(highs[-40:], 90)), 2)
    pivot = round((float(highs[-1]) + float(lows[-1]) + last_close) / 3, 2)

    #  Price Targets (based on AI + volatility) 
    vol_20 = float(last.get('Vol_20', 0.02))
    if vol_20 < 0.001: vol_20 = 0.02
    direction_mult = (ai_prob - 0.5) * 2  # -1 to +1
    target_1d = round(last_close * (1 + direction_mult * vol_20 * 1.0), 2)
    target_5d = round(last_close * (1 + direction_mult * vol_20 * 2.2), 2)
    target_10d = round(last_close * (1 + direction_mult * vol_20 * 3.5), 2)

    #  52-Week High / Low 
    all_closes = tdf['Close'].values
    all_highs = tdf['High'].values
    all_lows = tdf['Low'].values
    high_52w = round(float(np.max(all_highs[-252:])) if len(all_highs) >= 252 else float(np.max(all_highs)), 2)
    low_52w = round(float(np.min(all_lows[-252:])) if len(all_lows) >= 252 else float(np.min(all_lows)), 2)
    pct_from_high = round(((last_close - high_52w) / high_52w) * 100, 2)

    #  AI Gauge Score (0-100, 50=neutral) 
    gauge_score = round(ai_prob * 100, 1)

    #  Day Range 
    day_high = round(float(last['High']), 2)
    day_low = round(float(last['Low']), 2)

    #  Bollinger Bands for charting 
    bb_upper = (recent['SMA_20'] + 2 * recent['Close'].rolling(20).std()).round(2).tolist()
    bb_lower = (recent['SMA_20'] - 2 * recent['Close'].rolling(20).std()).round(2).tolist()

    result = {
        'ticker': ticker,
        'prediction': 'BULLISH' if ai_prob > 0.55 else 'BEARISH' if ai_prob < 0.45 else 'NEUTRAL',
        'confidence': round(max(ai_prob, 1-ai_prob) * 100, 1),
        'ai_probability': round(ai_prob, 4),
        'forecasts': forecasts,
        'last_close': round(last_close, 2),
        'current_price': current_price,
        'change': rt_change if rt_change is not None else round(change, 2),
        'change_pct': rt_change_pct if rt_change_pct is not None else round(change_pct, 2),
        'market_cap': market_cap,
        'last_date': last_date,
        'is_realtime': current_price is not None,
        'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'gauge_score': gauge_score,
        'support_resistance': {
            'support_1': support_1, 'support_2': support_2,
            'resistance_1': resistance_1, 'resistance_2': resistance_2,
            'pivot': pivot,
        },
        'price_targets': {
            '1d': target_1d, '5d': target_5d, '10d': target_10d,
        },
        'stats': {
            'high_52w': high_52w, 'low_52w': low_52w,
            'pct_from_high': pct_from_high,
            'day_high': day_high, 'day_low': day_low,
            'avg_volume': int(np.mean(recent['Volume'].values[-20:])),
        },
        'indicators': {
            'rsi': round(float(last.get('RSI_14', 0)), 2),
            'macd': round(float(last.get('MACD', 0)), 4),
            'macd_signal': round(float(last.get('MACD_Sig', 0)), 4),
            'macd_hist': round(float(last.get('MACD_Hist', 0)), 4),
            'trend_align': int(last.get('Trend_Align', 0)),
            'rsi_7': round(float(last.get('RSI_7', 0)), 2),
            'rsi_21': round(float(last.get('RSI_21', 0)), 2),
            'bb_pos': round(float(last.get('BB_Pos', 0.5)), 4),
            'bb_width': round(float(last.get('BB_Width', 0)), 4),
            'volatility_20d': round(float(last.get('Vol_20', 0)), 4),
        },
        'price_data': {
            'dates': recent['Date'].dt.strftime('%Y-%m-%d').tolist(),
            'open': recent['Open'].round(2).tolist(),
            'high': recent['High'].round(2).tolist(),
            'low': recent['Low'].round(2).tolist(),
            'close': recent['Close'].round(2).tolist(),
            'volume': recent['Volume'].astype(int).tolist(),
            'sma20': recent['SMA_20'].round(2).tolist(),
            'sma50': recent['SMA_50'].round(2).tolist(),
            'ema5': recent['EMA_5'].round(2).tolist(),
            'rsi': recent['RSI_14'].round(2).tolist(),
            'bb_upper': bb_upper,
            'bb_lower': bb_lower,
        }
    }
    return jsonify(clean_nan(result))


@app.route('/api/quote/<ticker>')
def quick_quote(ticker):
    """Quick real-time quote endpoint for auto-refresh."""
    ticker = ticker.upper()
    quote = get_realtime_quote(ticker)
    if quote and quote.get('current_price'):
        return jsonify({
            'ticker': ticker,
            'price': round(quote['current_price'], 2),
            'prev_close': round(quote['previous_close'], 2) if quote.get('previous_close') else None,
            'change': round(quote['current_price'] - quote['previous_close'], 2) if quote.get('previous_close') else None,
            'change_pct': round(((quote['current_price'] - quote['previous_close']) / quote['previous_close']) * 100, 2) if quote.get('previous_close') else None,
            'timestamp': datetime.now().strftime('%H:%M:%S'),
        })
    return jsonify({'error': 'Quote unavailable'}), 400


@app.route('/api/market_overview')
def market_overview():
    """Get quick overview of major indices - uses batch download."""
    now = time.time()
    if 'mkt_overview' in CACHE and now - CACHE.get('mkt_overview_ts', 0) < 120:
        return jsonify(CACHE['mkt_overview'])
    
    indices = ['SPY', 'QQQ', 'DIA', 'IWM']
    results = []
    try:
        data = yf.download(indices, period='2d', interval='1d', progress=False, auto_adjust=True, threads=True)
        if not data.empty:
            close = data['Close']
            if isinstance(close, pd.Series):
                close = close.to_frame()
            for idx in indices:
                try:
                    vals = close[idx].dropna().values if idx in close.columns else None
                    if vals is not None and len(vals) >= 2:
                        cur = round(float(vals[-1]), 2)
                        prev = round(float(vals[-2]), 2)
                        chg = round(cur - prev, 2)
                        chg_pct = round((chg / prev) * 100, 2) if prev else 0
                        results.append({'ticker': idx, 'price': cur, 'change': chg, 'change_pct': chg_pct})
                except: pass
    except: pass
    
    CACHE['mkt_overview'] = results
    CACHE['mkt_overview_ts'] = now
    return jsonify(results)


if __name__ == '__main__':
    load_resources()
    app.run(debug=False, port=5000)
