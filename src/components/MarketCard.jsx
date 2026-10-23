import React, { useState } from 'react';
import './MarketCard.css';

/**
 * A market can take a draw bet when it has a draw label and a draw price.
 * Sports markets created before the three-way change have neither, so they
 * keep behaving like two-way markets until the next sync populates them.
 */
export function isThreeWayMarket(market) {
  if (!market) return false;
  const label = String(market.sideC || '').trim();
  const odds = Number(market.oddsC || 0);
  return Boolean(label) && Number.isFinite(odds) && odds > 1;
}

export default function MarketCard({ market, onBetClick }) {
  const [selectedSide, setSelectedSide] = useState(null);
  const [betAmount, setBetAmount] = useState('100');

  const formatCurrency = (amount) => {
    if (amount == null) return '$0';
    return new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatOdds = (odds) => (odds == null || !Number.isFinite(odds) ? '—' : odds.toFixed(2));
  const formatPercentage = (odds) => (odds == null || !Number.isFinite(odds) ? '0%' : Math.round(odds * 100) + '%');

  const isThreeWay = isThreeWayMarket(market);
  const isResolved = market.status === 'resolved';
  const outcome = market.outcome;

  const threeWayOutcome = (sideKey, label, odds) => {
    const labelText = label || sideKey;
    const active = selectedSide === sideKey;
    return (
      <div key={sideKey} className={'market-odds ' + (isResolved ? 'market-odds-resolved' : '')}>
        <span className={'odds-label ' + (active ? 'selected' : '')}>{labelText.toUpperCase()}</span>
        <span className={'odds-value ' + (active ? 'selected' : '')}>
          {isResolved ? (outcome === sideKey ? 'WON' : 'LOST') : formatOdds(odds)}
        </span>
      </div>
    );
  };

  const handleBetSubmit = () => {
    if (!selectedSide || !betAmount) return;
    onBetClick(market.id, selectedSide, parseFloat(betAmount));
    setSelectedSide(null);
    setBetAmount('100');
  };

  if (isResolved) {
    return (
      <div className='market-card market-card-resolved'>
        <div className='market-card-header'>
          <span className='market-category'>{market.category}</span>
          <span className={'market-outcome ' + (['HOME','DRAW','AWAY'].includes(outcome) ? ('outcome-' + outcome.toLowerCase()) : 'outcome-no')}>
            {outcome?.toUpperCase()}
          </span>
        </div>
        <h3 className='market-title'>{market.title}</h3>
        <p className='market-description'>{market.description}</p>
        {threeWayOutcome('HOME')}
        {threeWayOutcome('DRAW')}
        {threeWayOutcome('AWAY')}
      </div>
    );
  }

  return (
    <div className='market-card'>
      <div className='market-card-header'>
        <span className='market-category'>{market.category}</span>
        {isResolved && (
          <span className={'market-outcome ' + (outcome === 'yes' ? 'outcome-yes' : 'outcome-no')}>
            {outcome?.toUpperCase()}
          </span>
        )}
      </div>

      <h3 className='market-title'>{market.title}</h3>
      <p className='market-description'>{market.description}</p>

      <div className='market-stats'>
        <div className='market-stat'><span className='stat-label'>Volume</span><span className='stat-value'>{formatCurrency(market.volume ?? market.home_volume ?? 0)}</span></div>
        <div className='market-stat'><span className='stat-label'>Participants</span><span className='stat-value'>{market.participants?.toLocaleString() ?? '0'}</span></div>
        <div className='market-stat'><span className='stat-label'>Ends</span><span className='stat-value'>{market.endDate ? new Date(market.endDate).toLocaleDateString() : 'TBD'}</span></div>
      </div>

      {!isResolved && (
        <>
          <div className='market-odds'>
            {isThreeWay ? (
              <>
                <div className='odds-item odds-home'><span className='odds-label'>HOME</span><span className='odds-value'>{formatOdds(market.oddsA || market.yesOdds)}</span></div>
                <div className='odds-divider' />
                <div className='odds-item odds-draw'><span className='odds-label'>DRAW</span><span className='odds-value'>{formatOdds(market.oddsC || market.noOdds)}</span></div>
                <div className='odds-divider' />
                <div className='odds-item odds-away'><span className='odds-label'>AWAY</span><span className='odds-value'>{formatOdds(market.oddsB || market.oddsA)}</span></div>
              </>
            ) : (
              <>
                <div className='odds-item odds-yes'><span className='odds-label'>YES</span><span className='odds-value'>{formatPercentage(market.yesOdds)}</span></div>
                <div className='odds-divider' />
                <div className='odds-item odds-no'><span className='odds-label'>NO</span><span className='odds-value'>{formatPercentage(market.noOdds)}</span></div>
              </>
            )}
          </div>

          <div className='betting-controls'>
            <div className='bet-amount-input'><span className='currency-symbol'>$</span><input type='number' value={betAmount} onChange={(e) => setBetAmount(e.target.value)} min='1' step='1' className='amount-field' /></div>
            <div className='bet-buttons'>
              {isThreeWay ? (
                <>
                  <button className={'bet-btn bet-home ' + (selectedSide === 'HOME' ? 'selected' : '')} onClick={() => setSelectedSide('HOME')}>HOME</button>
                  <button className={'bet-btn bet-draw ' + (selectedSide === 'DRAW' ? 'selected' : '')} onClick={() => setSelectedSide('DRAW')}>DRAW</button>
                  <button className={'bet-btn bet-away ' + (selectedSide === 'AWAY' ? 'selected' : '')} onClick={() => setSelectedSide('AWAY')}>AWAY</button>
                </>
              ) : (
                <>
                  <button className={'bet-btn bet-yes ' + (selectedSide === 'yes' ? 'selected' : '')} onClick={() => setSelectedSide('yes')}>YES</button>
                  <button className={'bet-btn bet-no ' + (selectedSide === 'no' ? 'selected' : '')} onClick={() => setSelectedSide('no')}>NO</button>
                </>
              )}
            </div>
            <button className='place-bet-btn' onClick={handleBetSubmit} disabled={!selectedSide || !betAmount || parseFloat(betAmount) <= 0}>Place Bet</button>
          </div>
        </>
      )}
    </div>
  );
}
