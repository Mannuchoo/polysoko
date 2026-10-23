import { useState, useEffect, useCallback } from 'react';

// API fetch wrapper (set up by api.js in the browser).
async function apiFetch(path, options) {
  const res = await window.apiFetch(path, options);
  if (!res?.success) {
    const msg = res?.message || 'Request failed';
    throw new Error(msg);
  }
  return res;
}

export function useMarketData() {
  const [markets, setMarkets] = useState([]);
  const [categories, setCategories] = useState([]);
  const [balance, setBalance] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const normalizeMarket = (market) => {
    // The backend returns sideC/oddsC/draw_volume/odds_anchor for three-way
    // (sports) markets; keep the binary shorthand the components expect.
    const category = String(market.category || '').toLowerCase();
    return {
      ...market,
      category,
      yesOdds: Number(market.oddsA || market.yesOdds || 0),
      noOdds: Number(market.oddsB || market.noOdds || 0),
      oddsC: Number(market.oddsC || 0),
      draw_volume: Number(market.draw_volume || 0),
      volume: Number(market.volume || market.home_volume || 0),
      participants: Number(market.participants || 0),
      outcome: market.status === 'resolved' ? (market.result || null) : null,
    };
  };

  const fetchMarkets = useCallback(
    async (filter = selectedCategory) => {
      try {
        setLoading(true);
        setError(null);

        const params = new URLSearchParams();
        if (filter && filter !== 'all') {
          params.set('category', filter === 'football' ? 'sports' : filter);
        }
        const query = params.toString();
        const url = query ? `/api/markets?${query}` : '/api/markets';

        const res = await window.apiFetch(url);
        const normalized = (res.markets || []).map(normalizeMarket);
        setMarkets(normalized);

        const fromMarkets = [...new Set(normalized.map((m) => m.category))];
        setCategories((prev) => {
          const sports = prev.filter((c) => c.id === 'sports' || c.id === 'football');
          return [{ id: 'all', name: 'All Markets' }, ...fromMarkets, ...sports];
        });
      } catch (err) {
        setError(err.message ?? 'Failed to fetch markets');
      } finally {
        setLoading(false);
      }
    },
    [selectedCategory]
  );

  const fetchBalance = useCallback(async () => {
    try {
      const res = await window.apiFetch('/api/user/sync-wallet');
      setBalance(res?.balance ? { total: res.balance, available: res.balance, pending: 0 } : null);
    } catch (err) {
      setError(err.message ?? 'Failed to fetch balance');
    }
  }, []);

  const placeBet = useCallback(async (marketId, side, amount) => {
    try {
      setError(null);
      const res = await window.apiFetch('/api/place-bet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketId, side, amount }),
      });
      return res;
    } catch (err) {
      setError(err.message ?? 'Failed to place bet');
      return { success: false, error: err.message };
    }
  }, []);

  // Fetch markets for the current category on mount and whenever it changes.
  useEffect(() => {
    fetchMarkets(selectedCategory);
  }, [selectedCategory, fetchMarkets]);

  useEffect(() => {
    fetchBalance();
  }, [fetchBalance]);

  return {
    markets,
    categories,
    balance,
    selectedCategory,
    setSelectedCategory,
    loading,
    error,
    placeBet,
    refetch: fetchMarkets,
  };
}

export default useMarketData;