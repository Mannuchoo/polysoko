import { useState, useEffect, useCallback } from 'react';

const MOCK_MARKETS = [
  {
    id: '1',
    title: 'Bitcoin to reach $100k by end of 2025?',
    description: 'Will Bitcoin (BTC) hit or exceed $100,000 USD before December 31, 2025?',
    category: 'crypto',
    endDate: '2025-12-31T23:59:59Z',
    status: 'active',
    yesOdds: 0.65,
    noOdds: 0.35,
    volume: 1250000,
    participants: 3420,
  },
  {
    id: '2',
    title: 'Ethereum flip Bitcoin market cap?',
    description: 'Will Ethereum (ETH) market capitalization surpass Bitcoin (BTC) in 2025?',
    category: 'crypto',
    endDate: '2025-12-31T23:59:59Z',
    status: 'active',
    yesOdds: 0.22,
    noOdds: 0.78,
    volume: 890000,
    participants: 2150,
  },
  {
    id: '3',
    title: 'Fed rate cut in Q1 2025?',
    description: 'Will the Federal Reserve cut interest rates in Q1 2025?',
    category: 'finance',
    endDate: '2025-03-31T23:59:59Z',
    status: 'active',
    yesOdds: 0.45,
    noOdds: 0.55,
    volume: 2100000,
    participants: 5100,
  },
  {
    id: '4',
    title: 'AI passes Turing Test 2025?',
    description: 'Will an AI system officially pass a standardized Turing Test in 2025?',
    category: 'tech',
    endDate: '2025-12-31T23:59:59Z',
    status: 'active',
    yesOdds: 0.38,
    noOdds: 0.62,
    volume: 560000,
    participants: 1890,
  },
  {
    id: '5',
    title: 'SpaceX Starship orbital launch success?',
    description: 'Will SpaceX Starship achieve a fully successful orbital launch and return in 2025?',
    category: 'tech',
    endDate: '2025-12-31T23:59:59Z',
    status: 'active',
    yesOdds: 0.72,
    noOdds: 0.28,
    volume: 780000,
    participants: 2400,
  },
  {
    id: '6',
    title: 'Trump wins 2024 US Election?',
    description: 'Will Donald Trump win the 2024 United States Presidential Election?',
    category: 'politics',
    endDate: '2024-11-05T23:59:59Z',
    status: 'resolved',
    yesOdds: 0.52,
    noOdds: 0.48,
    volume: 4500000,
    participants: 12500,
    outcome: 'yes',
  },
];

const MOCK_CATEGORIES = [
  { id: 'all', name: 'All Markets' },
  { id: 'crypto', name: 'Crypto' },
  { id: 'finance', name: 'Finance' },
  { id: 'tech', name: 'Tech' },
  { id: 'politics', name: 'Politics' },
  { id: 'sports', name: 'Sports' },
  { id: 'entertainment', name: 'Entertainment' },
];

const MOCK_BALANCE = {
  total: 5000.0,
  available: 3250.75,
  pending: 1749.25,
};

export function useMarketData() {
  const [markets, setMarkets] = useState([]);
  const [categories, setCategories] = useState([]);
  const [balance, setBalance] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchMarkets = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Simulate API call delay
      await new Promise((resolve) => setTimeout(resolve, 800));

      let filteredMarkets = MOCK_MARKETS;

      if (selectedCategory !== 'all') {
        filteredMarkets = MOCK_MARKETS.filter(
          (market) => market.category === selectedCategory
        );
      }

      setMarkets(filteredMarkets);
    } catch (err) {
      setError(err.message ?? 'Failed to fetch markets');
    } finally {
      setLoading(false);
    }
  }, [selectedCategory]);

  const fetchBalance = useCallback(async () => {
    try {
      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 300));
      setBalance(MOCK_BALANCE);
    } catch (err) {
      setError(err.message ?? 'Failed to fetch balance');
    }
  }, []);

  const placeBet = useCallback(async (marketId, side, amount) => {
    try {
      setError(null);

      // Simulate API call
      await new Promise((resolve) => setTimeout(resolve, 500));

      setMarkets((prevMarkets) =>
        prevMarkets.map((market) => {
          if (market.id === marketId) {
            return {
              ...market,
              volume: market.volume + amount,
              participants: market.participants + 1,
            };
          }
          return market;
        })
      );

      setBalance((prevBalance) => {
        if (!prevBalance) return prevBalance;
        return {
          ...prevBalance,
          available: prevBalance.available - amount,
          pending: prevBalance.pending + amount,
        };
      });

      return { success: true };
    } catch (err) {
      setError(err.message ?? 'Failed to place bet');
      return { success: false, error: err.message };
    }
  }, []);

  useEffect(() => {
    setCategories(MOCK_CATEGORIES);
  }, []);

  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

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