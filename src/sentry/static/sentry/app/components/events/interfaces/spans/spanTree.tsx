import React from 'react';
import styled from '@emotion/styled';

import {SentryTransactionEvent, Organization} from 'app/types';
import {t} from 'app/locale';
import {TableData} from 'app/views/eventsV2/table/types';

import {
  ProcessedSpanType,
  RawSpanType,
  SpanChildrenLookupType,
  ParsedTraceType,
  GapSpanType,
  TreeDepthType,
  OrphanTreeDepth,
} from './types';
import {
  boundsGenerator,
  SpanBoundsType,
  SpanGeneratedBoundsType,
  pickSpanBarColour,
  generateRootSpan,
  getSpanID,
  getSpanOperation,
  getSpanTraceID,
  isGapSpan,
  isOrphanSpan,
  isEventFromBrowserJavaScriptSDK,
  toPercent,
} from './utils';
import {DragManagerChildrenProps} from './dragManager';
import SpanGroup from './spanGroup';
import {SpanRowMessage, SPAN_ROW_HEIGHT} from './styles';
import * as DividerHandlerManager from './dividerHandlerManager';
import {FilterSpans} from './traceView';
import * as ScrollbarManager from './scrollbarManager';
import {DividerLine, DividerLineGhostContainer} from './spanBar';

type RenderedSpanTree = {
  spanTree: JSX.Element | null;
  nextSpanNumber: number;
  numOfSpansOutOfViewAbove: number;
  numOfFilteredSpansAbove: number;
};

type PropType = {
  orgId: string;
  organization: Organization;
  trace: ParsedTraceType;
  dragProps: DragManagerChildrenProps;
  filterSpans: FilterSpans | undefined;
  event: SentryTransactionEvent;
  spansWithErrors: TableData | null | undefined;
};

class SpanTree extends React.Component<PropType> {
  shouldComponentUpdate(nextProps: PropType) {
    if (nextProps.dragProps.isDragging || nextProps.dragProps.isWindowSelectionDragging) {
      return false;
    }

    return true;
  }

  traceViewRef = React.createRef<HTMLDivElement>();
  virtualScrollBarContainerRef = React.createRef<HTMLDivElement>();

  generateInfoMessage(input: {
    isCurrentSpanHidden: boolean;
    numOfSpansOutOfViewAbove: number;
    isCurrentSpanFilteredOut: boolean;
    numOfFilteredSpansAbove: number;
  }): React.ReactNode {
    const {
      isCurrentSpanHidden,
      numOfSpansOutOfViewAbove,
      isCurrentSpanFilteredOut,
      numOfFilteredSpansAbove,
    } = input;

    const messages: React.ReactNode[] = [];

    const showHiddenSpansMessage = !isCurrentSpanHidden && numOfSpansOutOfViewAbove > 0;

    if (showHiddenSpansMessage) {
      messages.push(
        <span key="spans-out-of-view">
          <strong>{numOfSpansOutOfViewAbove}</strong> {t('spans out of view')}
        </span>
      );
    }

    const showFilteredSpansMessage =
      !isCurrentSpanFilteredOut && numOfFilteredSpansAbove > 0;

    if (showFilteredSpansMessage) {
      if (!isCurrentSpanHidden) {
        messages.push(
          <span key="spans-filtered">
            <strong>{numOfFilteredSpansAbove}</strong> {t('spans filtered out')}
          </span>
        );
      }
    }

    if (messages.length <= 0) {
      return null;
    }

    return <SpanRowMessage>{messages}</SpanRowMessage>;
  }

  isSpanFilteredOut(span: Readonly<RawSpanType>): boolean {
    const {filterSpans} = this.props;

    if (!filterSpans) {
      return false;
    }

    return !filterSpans.spanIDs.has(getSpanID(span));
  }

  renderSpan = ({
    spanNumber,
    isRoot,
    isLast,
    treeDepth,
    continuingTreeDepths,
    numOfSpansOutOfViewAbove,
    numOfFilteredSpansAbove,
    childSpans,
    span,
    generateBounds,
    previousSiblingEndTimestamp,
  }: {
    spanNumber: number;
    treeDepth: number;
    continuingTreeDepths: Array<TreeDepthType>;
    isLast: boolean;
    isRoot?: boolean;
    numOfSpansOutOfViewAbove: number;
    numOfFilteredSpansAbove: number;
    span: Readonly<ProcessedSpanType>;
    childSpans: SpanChildrenLookupType;
    generateBounds: (bounds: SpanBoundsType) => SpanGeneratedBoundsType;
    previousSiblingEndTimestamp: undefined | number;
  }): RenderedSpanTree => {
    const {orgId, event, spansWithErrors, organization} = this.props;

    const spanBarColour: string = pickSpanBarColour(getSpanOperation(span));
    const spanChildren: Array<RawSpanType> = childSpans?.[getSpanID(span)] ?? [];

    // Mark descendents as being rendered. This is to address potential recursion issues due to malformed data.
    // For example if a span has a span_id that's identical to its parent_span_id.
    childSpans = {
      ...childSpans,
    };
    delete childSpans[getSpanID(span)];

    const bounds = generateBounds({
      startTimestamp: span.start_timestamp,
      endTimestamp: span.timestamp,
    });

    const isCurrentSpanHidden = !bounds.isSpanVisibleInView;
    const isCurrentSpanFilteredOut = isGapSpan(span)
      ? false
      : this.isSpanFilteredOut(span);

    const isSpanDisplayed = !isCurrentSpanHidden && !isCurrentSpanFilteredOut;

    // hide gap spans (i.e. "missing instrumentation" spans) for browser js transactions,
    // since they're not useful to indicate
    const shouldIncludeGap = !isEventFromBrowserJavaScriptSDK(event);

    const isValidGap =
      typeof previousSiblingEndTimestamp === 'number' &&
      previousSiblingEndTimestamp < span.start_timestamp &&
      // gap is at least 100 ms
      span.start_timestamp - previousSiblingEndTimestamp >= 0.1 &&
      shouldIncludeGap;

    const spanGroupNumber = isValidGap && isSpanDisplayed ? spanNumber + 1 : spanNumber;

    type AccType = {
      renderedSpanChildren: Array<JSX.Element>;
      nextSpanNumber: number;
      numOfSpansOutOfViewAbove: number;
      numOfFilteredSpansAbove: number;
      previousSiblingEndTimestamp: undefined | number;
    };

    const treeDepthEntry = isOrphanSpan(span)
      ? ({type: 'orphan', depth: treeDepth} as OrphanTreeDepth)
      : treeDepth;

    const treeArr = isLast
      ? continuingTreeDepths
      : [...continuingTreeDepths, treeDepthEntry];

    const reduced: AccType = spanChildren.reduce(
      (acc: AccType, spanChild, index) => {
        const key = `${getSpanTraceID(span)}${getSpanID(spanChild)}`;

        const results = this.renderSpan({
          spanNumber: acc.nextSpanNumber,
          isLast: index + 1 === spanChildren.length,
          continuingTreeDepths: treeArr,
          treeDepth: treeDepth + 1,
          numOfSpansOutOfViewAbove: acc.numOfSpansOutOfViewAbove,
          numOfFilteredSpansAbove: acc.numOfFilteredSpansAbove,
          span: spanChild,
          childSpans,
          generateBounds,
          previousSiblingEndTimestamp: acc.previousSiblingEndTimestamp,
        });

        acc.renderedSpanChildren.push(
          <React.Fragment key={key}>{results.spanTree}</React.Fragment>
        );

        acc.numOfSpansOutOfViewAbove = results.numOfSpansOutOfViewAbove;
        acc.numOfFilteredSpansAbove = results.numOfFilteredSpansAbove;

        acc.nextSpanNumber = results.nextSpanNumber;

        acc.previousSiblingEndTimestamp = spanChild.timestamp;

        return acc;
      },
      {
        renderedSpanChildren: [],
        nextSpanNumber: spanGroupNumber + 1,
        numOfSpansOutOfViewAbove: isCurrentSpanHidden ? numOfSpansOutOfViewAbove + 1 : 0,
        numOfFilteredSpansAbove: isCurrentSpanFilteredOut
          ? numOfFilteredSpansAbove + 1
          : isCurrentSpanHidden
          ? numOfFilteredSpansAbove
          : 0,
        previousSiblingEndTimestamp: undefined,
      }
    );

    const infoMessage = this.generateInfoMessage({
      isCurrentSpanHidden,
      numOfSpansOutOfViewAbove,
      isCurrentSpanFilteredOut,
      numOfFilteredSpansAbove,
    });

    const spanGap: Readonly<GapSpanType> = {
      type: 'gap',
      start_timestamp: previousSiblingEndTimestamp || span.start_timestamp,
      timestamp: span.start_timestamp, // this is essentially end_timestamp
      description: t('Missing instrumentation'),
      isOrphan: isOrphanSpan(span),
    };

    const spanGapComponent =
      isValidGap && isSpanDisplayed ? (
        <SpanGroup
          orgId={orgId}
          organization={organization}
          event={event}
          spanNumber={spanNumber}
          isLast={false}
          continuingTreeDepths={continuingTreeDepths}
          isRoot={isRoot}
          span={spanGap}
          trace={this.props.trace}
          generateBounds={generateBounds}
          treeDepth={treeDepth}
          numOfSpanChildren={0}
          renderedSpanChildren={[]}
          isCurrentSpanFilteredOut={isCurrentSpanFilteredOut}
          spansWithErrors={spansWithErrors}
          spanBarHatch
        />
      ) : null;

    return {
      numOfSpansOutOfViewAbove: reduced.numOfSpansOutOfViewAbove,
      numOfFilteredSpansAbove: reduced.numOfFilteredSpansAbove,
      nextSpanNumber: reduced.nextSpanNumber,
      spanTree: (
        <React.Fragment>
          {infoMessage}
          {spanGapComponent}
          <SpanGroup
            orgId={orgId}
            organization={organization}
            event={event}
            spanNumber={spanGroupNumber}
            isLast={isLast}
            continuingTreeDepths={continuingTreeDepths}
            isRoot={isRoot}
            span={span}
            trace={this.props.trace}
            generateBounds={generateBounds}
            treeDepth={treeDepth}
            numOfSpanChildren={spanChildren.length}
            renderedSpanChildren={reduced.renderedSpanChildren}
            spanBarColour={spanBarColour}
            isCurrentSpanFilteredOut={isCurrentSpanFilteredOut}
            spanBarHatch={false}
            spansWithErrors={spansWithErrors}
          />
        </React.Fragment>
      ),
    };
  };

  renderRootSpan = (): RenderedSpanTree => {
    const {dragProps, trace} = this.props;

    const rootSpan: RawSpanType = generateRootSpan(trace);

    const generateBounds = boundsGenerator({
      traceStartTimestamp: trace.traceStartTimestamp,
      traceEndTimestamp: trace.traceEndTimestamp,
      viewStart: dragProps.viewWindowStart,
      viewEnd: dragProps.viewWindowEnd,
    });

    return this.renderSpan({
      isRoot: true,
      isLast: true,
      spanNumber: 1,
      treeDepth: 0,
      continuingTreeDepths: [],
      numOfSpansOutOfViewAbove: 0,
      numOfFilteredSpansAbove: 0,
      span: rootSpan,
      childSpans: trace.childSpans,
      generateBounds,
      previousSiblingEndTimestamp: undefined,
    });
  };

  renderDivider(
    dividerHandlerChildrenProps: DividerHandlerManager.DividerHandlerManagerChildrenProps
  ) {
    const {addDividerLineRef} = dividerHandlerChildrenProps;

    return (
      <DividerLine
        ref={addDividerLineRef()}
        style={{
          position: 'relative',
        }}
        onMouseEnter={() => {
          dividerHandlerChildrenProps.setHover(true);
        }}
        onMouseLeave={() => {
          dividerHandlerChildrenProps.setHover(false);
        }}
        onMouseOver={() => {
          dividerHandlerChildrenProps.setHover(true);
        }}
        onMouseDown={dividerHandlerChildrenProps.onDragStart}
        onClick={event => {
          // we prevent the propagation of the clicks from this component to prevent
          // the span detail from being opened.
          event.stopPropagation();
        }}
      />
    );
  }

  render() {
    const {
      spanTree,
      numOfSpansOutOfViewAbove,
      numOfFilteredSpansAbove,
    } = this.renderRootSpan();

    const infoMessage = this.generateInfoMessage({
      isCurrentSpanHidden: false,
      numOfSpansOutOfViewAbove,
      isCurrentSpanFilteredOut: false,
      numOfFilteredSpansAbove,
    });

    return (
      <DividerHandlerManager.Provider interactiveLayerRef={this.traceViewRef}>
        <DividerHandlerManager.Consumer>
          {dividerHandlerChildrenProps => {
            return (
              <ScrollbarManager.Provider
                dividerPosition={dividerHandlerChildrenProps.dividerPosition}
                interactiveLayerRef={this.virtualScrollBarContainerRef}
              >
                <FooContainer>
                  <TraceViewContainer ref={this.traceViewRef}>
                    {spanTree}
                    {infoMessage}
                  </TraceViewContainer>
                  <ScrollbarManager.Consumer>
                    {({virtualScrollbarRef, onDragStart}) => {
                      return (
                        <React.Fragment>
                          <VirtualScrollBarSpanRow>
                            <ScrollBarContainer
                              style={{
                                width: `calc(${toPercent(
                                  dividerHandlerChildrenProps.dividerPosition
                                )} - 0.5px)`,
                              }}
                            />
                            {this.renderDivider(dividerHandlerChildrenProps)}
                            {
                              <DividerLineGhostContainer
                                style={{
                                  width: `calc(${toPercent(
                                    dividerHandlerChildrenProps.dividerPosition
                                  )} + 0.5px)`,
                                  display: 'none',
                                }}
                              >
                                <DividerLine
                                  ref={dividerHandlerChildrenProps.addGhostDividerLineRef()}
                                  style={{
                                    right: 0,
                                  }}
                                  className="hovering"
                                  onClick={event => {
                                    // the ghost divider line should not be interactive.
                                    // we prevent the propagation of the clicks from this component to prevent
                                    // the span detail from being opened.
                                    event.stopPropagation();
                                  }}
                                />
                              </DividerLineGhostContainer>
                            }
                          </VirtualScrollBarSpanRow>
                          <ScrollBarContainer
                            ref={this.virtualScrollBarContainerRef}
                            style={{
                              width: `calc(${toPercent(
                                dividerHandlerChildrenProps.dividerPosition
                              )} - 0.5px)`,
                            }}
                          >
                            <VirtualScrollBar
                              data-type="virtual-scrollbar"
                              ref={virtualScrollbarRef}
                              onMouseDown={onDragStart}
                            >
                              <VirtualScrollBarGrip />
                            </VirtualScrollBar>
                          </ScrollBarContainer>
                        </React.Fragment>
                      );
                    }}
                  </ScrollbarManager.Consumer>
                </FooContainer>
              </ScrollbarManager.Provider>
            );
          }}
        </DividerHandlerManager.Consumer>
      </DividerHandlerManager.Provider>
    );
  }
}

const TraceViewContainer = styled('div')`
  overflow-x: hidden;
  border-bottom-left-radius: 3px;
  border-bottom-right-radius: 3px;
`;

// TODO: rename this
const FooContainer = styled('div')`
  &:hover div[data-type='virtual-scrollbar'] > div {
    background-color: rgba(48, 40, 57, 0.5);
  }
`;

const VirtualScrollBarSpanRow = styled('div')`
  display: flex;
  position: relative;
  height: ${SPAN_ROW_HEIGHT}px;
`;

const ScrollBarContainer = styled('div')`
  display: flex;
  align-items: center;

  width: 100%;
  position: sticky;
  height: 20px;
  margin-top: -20px;

  left: 0;
  bottom: 0;
  z-index: 999;

  & > div[data-type='virtual-scrollbar'].dragging > div {
    background-color: ${p => p.theme.gray800};
  }
`;

const VirtualScrollBar = styled('div')`
  height: 8px;
  width: 0;
  padding-left: 4px;
  padding-right: 4px;

  position: relative;
  top: 0;
  left: 0;
`;

const VirtualScrollBarGrip = styled('div')`
  height: 8px;
  width: 100%;

  border-radius: 20px 20px 20px 20px;

  transition: background-color 150ms ease;
`;

export default SpanTree;
