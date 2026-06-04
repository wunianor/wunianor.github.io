// Adapted from Docsy offline-search.js; localized for zh-cn site.

(function ($) {
  'use strict';

  $(document).ready(function () {
    const $searchInputs = $('.td-search input[data-offline-search-index-json-src]');
    if ($searchInputs.length === 0) {
      return;
    }

    const $searchInput = $searchInputs.first();
    const indexSrc = $searchInput.data('offline-search-index-json-src');
    const baseHref = $searchInput.data('offline-search-base-href') || '/';

    const onQueryChange = (event) => {
      render($(event.target));
      $(event.target).blur();
    };

    $searchInputs.on('input change', onQueryChange);

    $searchInputs.closest('form').on('submit', () => false);

    let idx = null;
    const resultDetails = new Map();

    $.ajax(indexSrc).then((data) => {
      idx = lunr(function () {
        this.ref('ref');
        this.field('title', { boost: 5 });
        this.field('categories', { boost: 3 });
        this.field('tags', { boost: 3 });
        this.field('description', { boost: 2 });
        this.field('body');

        data.forEach((doc) => {
          this.add(doc);
          resultDetails.set(doc.ref, {
            title: doc.title,
            excerpt: doc.excerpt,
          });
        });
      });
    });

    const render = ($targetSearchInput) => {
      {
        const popover = bootstrap.Popover.getInstance($targetSearchInput[0]);
        if (popover !== null) {
          popover.dispose();
        }
      }

      if (idx === null) {
        return;
      }

      const searchQuery = $targetSearchInput.val();
      if (searchQuery === '') {
        return;
      }

      const maxResults = $targetSearchInput.data('offline-search-max-results') || 10;
      const results = idx
        .query((q) => {
          const tokens = lunr.tokenizer(searchQuery.toLowerCase());
          tokens.forEach((token) => {
            const queryString = token.toString();
            q.term(queryString, { boost: 100 });
            q.term(queryString, {
              wildcard: lunr.Query.wildcard.LEADING | lunr.Query.wildcard.TRAILING,
              boost: 10,
            });
            q.term(queryString, { editDistance: 2 });
          });
        })
        .slice(0, maxResults);

      const $html = $('<div>');

      $html.append(
        $('<div>')
          .css({
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: '1em',
          })
          .append($('<span>').text('搜索结果').css({ fontWeight: 'bold' }))
          .append($('<span>').addClass('td-offline-search-results__close-button'))
      );

      const $searchResultBody = $('<div>').css({
        maxHeight: `calc(100vh - ${
          $targetSearchInput.offset().top - $(window).scrollTop() + 180
        }px)`,
        overflowY: 'auto',
      });
      $html.append($searchResultBody);

      if (results.length === 0) {
        $searchResultBody.append(
          $('<p>').text(`未找到与「${searchQuery}」相关的内容`)
        );
      } else {
        results.forEach((r) => {
          const doc = resultDetails.get(r.ref);
          const href = baseHref + r.ref.replace(/^\//, '');

          const $entry = $('<div>').addClass('mt-4');

          $entry.append(
            $('<small>').addClass('d-block text-body-secondary').text(r.ref)
          );

          $entry.append(
            $('<a>')
              .addClass('d-block')
              .css({ fontSize: '1.2rem' })
              .attr('href', href)
              .text(doc.title)
          );

          $entry.append($('<p>').text(doc.excerpt));

          $searchResultBody.append($entry);
        });
      }

      $targetSearchInput.one('shown.bs.popover', () => {
        $('.td-offline-search-results__close-button').on('click', () => {
          $targetSearchInput.val('');
          $targetSearchInput.trigger('change');
        });
      });

      const popover = new bootstrap.Popover($targetSearchInput, {
        content: $html[0],
        html: true,
        customClass: 'td-offline-search-results',
        placement: 'bottom',
      });
      popover.show();
    };
  });
})(jQuery);
