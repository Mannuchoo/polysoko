import React from 'react';
import './Header.css';

export default function Header({ user, onMenuClick }) {
  return (
    <header className="header">
      <div className="header-left">
        <button className="menu-toggle" onClick={onMenuClick} aria-label="Toggle menu">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <div className="logo">
          <span className="logo-icon">🎯</span>
          <span className="logo-text">PolySoko</span>
        </div>
      </div>

      <div className="header-center">
        <nav className="nav-pills">
          <button className="nav-pill active">Markets</button>
          <button className="nav-pill">Portfolio</button>
          <button className="nav-pill">Leaderboard</button>
        </nav>
      </div>

      <div className="header-right">
        {user ? (
          <div className="user-menu">
            <div className="user-avatar">
              {user.avatar ? (
                <img src={user.avatar} alt={user.username} />
              ) : (
                <span>{user.username?.charAt(0)?.toUpperCase() ?? 'U'}</span>
              )}
            </div>
            <span className="username">{user.username ?? 'User'}</span>
          </div>
        ) : (
          <button className="btn btn-primary">Connect Wallet</button>
        )}
      </div>
    </header>
  );
}