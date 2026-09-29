import React from 'react';
import './BalanceCard.css';

export default function BalanceCard({ balance, currency = 'USD' }) {
  const formatCurrency = (amount) => {
    if (amount == null) return '0.00';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  return (
    <div className="balance-card">
      <div className="balance-header">
        <h3 className="balance-title">Portfolio Balance</h3>
        <span className="balance-badge">Live</span>
      </div>

      <div className="balance-main">
        <span className="balance-amount">{formatCurrency(balance?.total ?? 0)}</span>
      </div>

      <div className="balance-details">
        <div className="balance-item">
          <span className="balance-label">Available</span>
          <span className="balance-value available">{formatCurrency(balance?.available ?? 0)}</span>
        </div>
        <div className="balance-divider" />
        <div className="balance-item">
          <span className="balance-label">Pending</span>
          <span className="balance-value pending">{formatCurrency(balance?.pending ?? 0)}</span>
        </div>
      </div>
    </div>
  );
}