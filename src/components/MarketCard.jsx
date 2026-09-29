import React, { useState } from 'react';
import './MarketCard.css';

export default function MarketCard({ market, onBetClick }) {
  const [selectedSide, setSelectedSide] = useState(null);
  const [betAmount, setBetAmount] = useState('100');

  const formatCurrency = (amount) => {
    if (amount == null) return '$0';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatPercentage = (odds) => {
    if (odds == null) return '0%';
    return `${Math.round(odds * 100)}%`;
  };

  const handleBetSubmit = () => {
    if (!selectedSide || !betAmount) return;
    onBetClick(market.id, selectedSide, parseFloat(betAmount));
    setSelectedSide(null);
    setBetAmount('100');
  };

  const isResolved = market.status === 'resolved';
  const outcome = market.outcome;

  return (
    <div className={`market-card ${isResolved ? 'market-card-resolved' : ''}`}>
      <div className="market-card-header">
        <span className="market-category">{market.category}</span>
        {isResolved && (
          <span className={`market-outcome ${outcome === 'yes' ? 'outcome-yes' : 'outcome-no'}`}>
            {outcome?.toUpperCase()}
          </span>
        )}
      </div>

      <h3 className="market-title">{market.title}</h3>
      <p className="market-description">{market.description}</p>

      <div className="market-stats">
        <div className="market-stat">
          <span className="stat-label">Volume</span>
          <span className="stat-value">{formatCurrency(market.volume)}</span>
        </div>
        <div className="market-stat">
          <span className="stat-label">Participants</span>
          <span className="stat-value">{market.participants?.toLocaleString() ?? '0'}</span>
        </div>
        <div className="market-stat">
          <span className="stat-label">Ends</span>
          <span className="stat-value">
            {market.endDate ? new Date(market.endDate).toLocaleDateString() : 'TBD'}
          </span>
        </div>
      </div>

      {!isResolved && (
        <>
          <div className="market-odds">
            <div className="odds-item odds-yes">
              <span className="odds-label">YES</span>
              <span className="odds-value">{formatPercentage(market.yesOdds)}</span>
            </div>
            <div className="odds-divider" />
            <div className="odds-item odds-no">
              <span className="odds-label">NO</span>
              <span className="odds-value">{formatPercentage(market.noOdds)}</span>
            </div>
          </div>

          <div className="betting-controls">
            <div className="bet-amount-input">
              <span className="currency-symbol">$</span>
              <input
                type="number"
                value={betAmount}
                onChange={(e) => setBetAmount(e.target.value)}
                min="1"
                step="1"
                className="amount-field"
              />
            </div>

            <div className="bet-buttons">
              <button
                className={`bet-btn bet-yes ${selectedSide === 'yes' ? 'selected' : ''}`}
                onClick={() => setSelectedSide('yes')}
              >
                YES
              </button>
              <button
                className={`bet-btn bet-no ${selectedSide === 'no' ? 'selected' : ''}`}
                onClick={() => setSelectedSide('no')}
              >
                NO
              </button>
            </div>

            <button
              className="place-bet-btn"
              onClick={handleBetSubmit}
              disabled={!selectedSide || !betAmount || parseFloat(betAmount) <= 0}
            >
              Place Bet
            </button>
          </div>
        </>
      )}
    </div>
  );
}