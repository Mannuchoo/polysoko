import React from 'react';
import './Sidebar.css';

export default function Sidebar({ categories, selectedCategory, onCategorySelect, isOpen }) {
  return (
    <aside className={`sidebar ${isOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-section">
        <h4 className="sidebar-title">Categories</h4>
        <nav className="sidebar-nav">
          {categories?.map((category) => (
            <button
              key={category.id}
              className={`sidebar-link ${selectedCategory === category.id ? 'active' : ''}`}
              onClick={() => onCategorySelect(category.id)}
            >
              {category.icon && <span className="sidebar-icon">{category.icon}</span>}
              {category.name}
            </button>
          ))}
        </nav>
      </div>
    </aside>
  );
}