import React, { useState } from 'react';
import Layout from './components/Layout.jsx';
import { useMarketData } from './hooks/useMarketData.js';
import MarketCard from './components/MarketCard.jsx';
import './App.css';

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { markets, categories, balance, selectedCategory, setSelectedCategory, loading, error, placeBet } = useMarketData();

  const mockUser = {
    id: '1',
    username: 'DemoUser',
    email: 'demo@example.com',
    balance: balance?.total ?? 5000,
    createdAt: new Date().toISOString(),
  };

  const handleMenuClick = () => {
    setSidebarOpen((prev) => !prev);
  };

  const handleCategorySelect = (categoryId) => {
    setSelectedCategory(categoryId);
  };

  const handleBetClick = async (marketId, side) => {
    await placeBet(marketId, side, 100);
  };

  return (
    <Layout user={mockUser} onMenuClick={handleMenuClick}>
      <div className="markets-container">
        <div className="markets-header">
          <h1 className="markets-title">Prediction Markets</h1>
          <p className="markets-subtitle">Trade on the world's most compelling questions</p>
        </div>

        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <button onClick={() => window.location.reload()}>Retry</button>
          </div>
        )}

        <div className="category-pills">
          {categories?.map((category) => (
            <button
              key={category.id}
              className={`category-pill ${selectedCategory === category.id ? 'active' : ''}`}
              onClick={() => handleCategorySelect(category.id)}
            >
              {category.name}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="loading-grid">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="market-card-skeleton" />
            ))}
          </div>
        ) : (
          <div className="markets-grid">
            {markets?.map((market) => (
              <MarketCard
                key={market.id}
                market={market}
                onBetClick={handleBetClick}
              />
            ))}
          </div>
        )}

        {!loading && markets?.length === 0 && (
          <div className="empty-state">
            <p>No markets found in this category.</p>
          </div>
        )}
      </div>
    </Layout>
  );
}