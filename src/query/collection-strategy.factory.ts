import { ICollectionStrategy, CollectionStrategyType } from './collection-strategy.interface';
import { CteCollectionStrategy } from './strategies/cte-collection-strategy';
import { TempTableCollectionStrategy } from './strategies/temptable-collection-strategy';
import { LateralCollectionStrategy } from './strategies/lateral-collection-strategy';

/**
 * Factory for creating collection aggregation strategies
 */
export class CollectionStrategyFactory {
  private static strategies = new Map<CollectionStrategyType, ICollectionStrategy>();

  /**
   * Get a strategy instance (singleton per type)
   */
  static getStrategy(type: CollectionStrategyType): ICollectionStrategy {
    if (!this.strategies.has(type)) {
      switch (type) {
        case 'cte':
          this.strategies.set(type, new CteCollectionStrategy());
          break;
        case 'temptable':
          this.strategies.set(type, new TempTableCollectionStrategy());
          break;
        case 'lateral':
          this.strategies.set(type, new LateralCollectionStrategy());
          break;
        default:
          throw new Error(`Unknown collection strategy type: ${type}`);
      }
    }
    return this.strategies.get(type)!;
  }

  /**
   * Clear cached strategies (mainly for testing)
   */
  static clearCache(): void {
    this.strategies.clear();
  }
}
