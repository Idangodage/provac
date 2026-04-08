'use client';

import { X, Copy, ArrowRight } from 'lucide-react';
import React, { useState } from 'react';

export interface CalculatorProps {
  onInsert: (value: string) => void;
  onClose: () => void;
}

/**
 * Calculator widget for the document editor.
 */
export const Calculator: React.FC<CalculatorProps> = ({ onInsert, onClose }) => {
  const [display, setDisplay] = useState('0');
  const [memory, setMemory] = useState<number | null>(null);
  const [operator, setOperator] = useState<string | null>(null);
  const [waitingForOperand, setWaitingForOperand] = useState(false);

  const inputDigit = (digit: string) => {
    if (waitingForOperand) {
      setDisplay(digit);
      setWaitingForOperand(false);
    } else {
      setDisplay(display === '0' ? digit : display + digit);
    }
  };

  const inputDecimal = () => {
    if (waitingForOperand) {
      setDisplay('0.');
      setWaitingForOperand(false);
      return;
    }
    if (!display.includes('.')) {
      setDisplay(display + '.');
    }
  };

  const clear = () => {
    setDisplay('0');
    setMemory(null);
    setOperator(null);
    setWaitingForOperand(false);
  };

  const performOperation = (nextOperator: string) => {
    const inputValue = parseFloat(display);

    if (memory === null) {
      setMemory(inputValue);
    } else if (operator) {
      const currentValue = memory || 0;
      let result = 0;

      switch (operator) {
        case '+':
          result = currentValue + inputValue;
          break;
        case '-':
          result = currentValue - inputValue;
          break;
        case '*':
          result = currentValue * inputValue;
          break;
        case '/':
          result = inputValue !== 0 ? currentValue / inputValue : 0;
          break;
        case '%':
          result = currentValue % inputValue;
          break;
        default:
          result = inputValue;
      }

      setDisplay(String(result));
      setMemory(result);
    }

    setWaitingForOperand(true);
    setOperator(nextOperator);
  };

  const calculate = () => {
    if (operator && memory !== null) {
      performOperation('=');
      setOperator(null);
    }
  };

  const handleInsert = () => {
    onInsert(display);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(display);
  };

  const buttonStyle = (color: string = '#f0f0f0'): React.CSSProperties => ({
    padding: '12px',
    fontSize: 16,
    backgroundColor: color,
    border: 'none',
    borderRadius: 4,
    cursor: 'pointer',
    transition: 'background-color 0.2s',
  });

  return (
    <div
      style={{
        position: 'absolute',
        top: 20,
        right: 20,
        width: 280,
        backgroundColor: 'white',
        borderRadius: 8,
        boxShadow: '0 4px 20px rgba(0, 0, 0, 0.2)',
        zIndex: 1000,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid #e0e0e0',
          backgroundColor: '#f8f9fa',
          borderRadius: '8px 8px 0 0',
        }}
      >
        <span style={{ fontWeight: 'bold', fontSize: 14 }}>Calculator</span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 4,
          }}
        >
          <X size={16} color="#666" />
        </button>
      </div>

      {/* Display */}
      <div
        style={{
          padding: '16px',
          backgroundColor: '#333',
          color: 'white',
          fontSize: 24,
          textAlign: 'right',
          fontFamily: 'monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {display}
      </div>

      {/* Buttons */}
      <div style={{ padding: 12 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
          }}
        >
          {/* Row 1 */}
          <button onClick={clear} style={buttonStyle('#ff6b6b')}>C</button>
          <button onClick={() => performOperation('%')} style={buttonStyle('#e0e0e0')}>%</button>
          <button onClick={() => setDisplay(String(-parseFloat(display)))} style={buttonStyle('#e0e0e0')}>±</button>
          <button onClick={() => performOperation('/')} style={buttonStyle('#0066cc')}>÷</button>

          {/* Row 2 */}
          <button onClick={() => inputDigit('7')} style={buttonStyle()}>7</button>
          <button onClick={() => inputDigit('8')} style={buttonStyle()}>8</button>
          <button onClick={() => inputDigit('9')} style={buttonStyle()}>9</button>
          <button onClick={() => performOperation('*')} style={buttonStyle('#0066cc')}>×</button>

          {/* Row 3 */}
          <button onClick={() => inputDigit('4')} style={buttonStyle()}>4</button>
          <button onClick={() => inputDigit('5')} style={buttonStyle()}>5</button>
          <button onClick={() => inputDigit('6')} style={buttonStyle()}>6</button>
          <button onClick={() => performOperation('-')} style={buttonStyle('#0066cc')}>−</button>

          {/* Row 4 */}
          <button onClick={() => inputDigit('1')} style={buttonStyle()}>1</button>
          <button onClick={() => inputDigit('2')} style={buttonStyle()}>2</button>
          <button onClick={() => inputDigit('3')} style={buttonStyle()}>3</button>
          <button onClick={() => performOperation('+')} style={buttonStyle('#0066cc')}>+</button>

          {/* Row 5 */}
          <button onClick={() => inputDigit('0')} style={{ ...buttonStyle(), gridColumn: 'span 2' }}>0</button>
          <button onClick={inputDecimal} style={buttonStyle()}>.</button>
          <button onClick={calculate} style={buttonStyle('#28a745')}>=</button>
        </div>

        {/* Action Buttons */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginTop: 12,
            paddingTop: 12,
            borderTop: '1px solid #e0e0e0',
          }}
        >
          <button
            onClick={handleCopy}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '10px',
              fontSize: 12,
              backgroundColor: '#f0f0f0',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            <Copy size={14} />
            Copy
          </button>
          <button
            onClick={handleInsert}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: '10px',
              fontSize: 12,
              backgroundColor: '#0066cc',
              color: 'white',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            <ArrowRight size={14} />
            Insert
          </button>
        </div>
      </div>
    </div>
  );
};

export default Calculator;
